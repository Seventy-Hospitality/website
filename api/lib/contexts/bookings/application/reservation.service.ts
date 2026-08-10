import type { UnitOfWork } from '@/lib/kernel';
import {
  addDaysToDateKey,
  minutesToTimeLabel,
  wallTimeToUtc,
  zonedDateKey,
} from '@/lib/kernel';
import {
  type BookingPaymentPort,
  type MembershipChecker,
  type ParticipantResponse,
  type ReservationPayment,
  type Resource,
  type ResourceType,
  type SlotGridConfig,
  applyParticipantResponse,
  allocateRefund,
  canManageInvites,
  computeNetPaidCents,
  computeRefundCents,
  computeTotalCents,
  freeSlotStartsByResource,
  isActiveReservationStatus,
  parseSlotSelection,
  refundPercentFor,
  resourcesFreeForSelection,
  selectionToRange,
  tierSatisfies,
  unionSlotStarts,
  HoldExpiredError,
  InactiveMembershipError,
  InvalidReservationStatusError,
  InviteeNotFoundError,
  MaxReservationsExceededError,
  NotInvitePermittedError,
  CannotRemoveOrganizerError,
  ParticipantNotFoundError,
  PaymentNotCompletedError,
  ReservationAlreadyStartedError,
  ReservationInPastError,
  ReservationNotFoundError,
  ReservationTooFarInAdvanceError,
  ResourceNotFoundError,
  ResourceTypeNotFoundError,
  SlotUnavailableError,
  TierRequiredError,
} from '../domain';
import type {
  ReservationRepository,
  ReservationDetailRecord,
} from '../infrastructure/reservation.repository';
import type { ResourceRepository, ResourceTypeRepository } from '../infrastructure/resource.repository';
import type { SlotClaimRepository } from '../infrastructure/slot-claim.repository';
import type { AuditLog } from './ports';

const STREAM_TYPE = 'reservation';

export interface SchedulingConfig {
  /** The venue's IANA timezone; the single wall clock all slots live on. */
  timezone: string;
  /** Checkout hold TTL in minutes (~12-15 per the settled design). */
  holdMinutes?: number;
}

export interface AvailabilitySlot {
  start: string; // "HH:MM" venue wall clock; hours may reach 24+ past midnight
  startsAt: string; // ISO instant
}

export interface AvailabilityDay {
  date: string;
  slots: AvailabilitySlot[];
}

export interface SlotSelectionRequest {
  typeCode: string;
  date: string; // "YYYY-MM-DD" venue-local
  slots: string[]; // "HH:MM" labels
}

export interface QuoteResult {
  typeCode: string;
  date: string;
  slots: string[];
  durationMinutes: number;
  hourlyRateCents: number;
  totalCents: number;
}

export interface CreateReservationResult {
  reservation: ReservationDetailRecord;
  clientSecret: string | null;
  holdExpiresAt: Date | null;
  totalCents: number;
}

export interface RescheduleQuoteResult {
  date: string;
  slots: string[];
  durationMinutes: number;
  newTotalCents: number;
  netPaidCents: number;
  /** Positive: additional charge. Negative: refund. */
  deltaCents: number;
}

export interface ViewerContext {
  role: 'organizer' | 'guest';
  status: string;
  canInvite: boolean;
  canManage: boolean;
  canRespond: boolean;
}

export class ReservationService {
  private readonly timezone: string;
  private readonly holdMinutes: number;

  constructor(
    private readonly typeRepo: ResourceTypeRepository,
    private readonly resourceRepo: ResourceRepository,
    private readonly claimRepo: SlotClaimRepository,
    private readonly reservationRepo: ReservationRepository,
    private readonly membershipChecker: MembershipChecker,
    private readonly paymentPort: BookingPaymentPort,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    config: SchedulingConfig,
  ) {
    this.timezone = config.timezone;
    this.holdMinutes = config.holdMinutes ?? 12;
  }

  // ── Catalog ──

  async listResourceTypesForMember(memberId: string) {
    const [types, counts, tier] = await Promise.all([
      this.typeRepo.listActive(),
      this.resourceRepo.countActiveByType(),
      this.membershipChecker.getTier(memberId),
    ]);

    return types.map((type) => ({
      ...type,
      resourceCount: counts.get(type.id) ?? 0,
      locked: !tierSatisfies(tier, type.minTier),
    }));
  }

  // ── Availability ──

  /**
   * Per-date bookable slots for a type: computed per resource, then unioned.
   * Pre-filtered by operating hours, horizon, tier, per-member daily limit
   * and (for today) already-started slots. `excludeReservationId` is the edit
   * screen's self-exclusion: the reservation's own claim does not block it.
   */
  async getAvailability(params: {
    typeCode: string;
    startDate: string;
    days?: number;
    memberId: string;
    excludeReservationId?: string;
    now?: Date;
  }): Promise<AvailabilityDay[]> {
    const now = params.now ?? new Date();
    const days = Math.max(1, Math.min(params.days ?? 1, 31));
    const type = await this.getActiveType(params.typeCode);
    await this.assertTier(params.memberId, type);

    const resources = await this.resourceRepo.listActiveByType(type.id);
    const dateKeys = Array.from({ length: days }, (_, i) => addDaysToDateKey(params.startDate, i));
    const todayKey = zonedDateKey(now, this.timezone);
    const horizonKey = addDaysToDateKey(todayKey, type.maxAdvanceDays);

    if (resources.length === 0) {
      return dateKeys.map((date) => ({ date, slots: [] }));
    }

    const windowFrom = wallTimeToUtc(dateKeys[0], 0, this.timezone);
    const windowTo = wallTimeToUtc(dateKeys[dateKeys.length - 1], type.opEndMinutes, this.timezone);
    const claims = await this.claimRepo.listActiveInWindow(
      resources.map((resource) => resource.id),
      windowFrom,
      windowTo,
      { excludeReservationId: params.excludeReservationId },
    );

    const config = this.gridConfig(type);
    const result: AvailabilityDay[] = [];

    for (const dateKey of dateKeys) {
      if (dateKey < todayKey || dateKey > horizonKey) {
        result.push({ date: dateKey, slots: [] });
        continue;
      }

      const dayCount = await this.reservationRepo.countActiveOnDate(undefined, {
        organizerId: params.memberId,
        resourceTypeId: type.id,
        localDate: dateKey,
        excludeReservationId: params.excludeReservationId,
      });
      if (dayCount >= type.maxReservationsPerMemberPerDay) {
        result.push({ date: dateKey, slots: [] });
        continue;
      }

      const perResource = freeSlotStartsByResource({
        dateKey,
        config,
        resourceIds: resources.map((resource) => resource.id),
        claims,
        timeZone: this.timezone,
        notBefore: dateKey === todayKey ? now : undefined,
      });

      result.push({
        date: dateKey,
        slots: unionSlotStarts(perResource).map((start) => ({
          start: minutesToTimeLabel(start),
          startsAt: wallTimeToUtc(dateKey, start, this.timezone).toISOString(),
        })),
      });
    }

    return result;
  }

  /**
   * Free grid of one specific resource for one date (admin views). No tier,
   * limit or horizon filtering: staff see the raw physical availability.
   */
  async getResourceAvailability(
    resourceId: string,
    dateKey: string,
  ): Promise<Array<{ startTime: string; endTime: string }>> {
    const resource = await this.resourceRepo.getById(resourceId);
    if (!resource || !resource.active) throw new ResourceNotFoundError(resourceId);
    const type = await this.typeRepo.getById(resource.typeId);
    if (!type) throw new ResourceNotFoundError(resourceId);

    const config = this.gridConfig(type);
    const claims = await this.claimRepo.listActiveInWindow(
      [resourceId],
      wallTimeToUtc(dateKey, 0, this.timezone),
      wallTimeToUtc(dateKey, type.opEndMinutes, this.timezone),
    );
    const perResource = freeSlotStartsByResource({
      dateKey,
      config,
      resourceIds: [resourceId],
      claims,
      timeZone: this.timezone,
    });

    return (perResource.get(resourceId) ?? []).map((start) => ({
      startTime: minutesToTimeLabel(start),
      endTime: minutesToTimeLabel(start + config.slotDurationMinutes),
    }));
  }

  // ── Quote ──

  /**
   * Validates that a SINGLE resource can host the entire slot set (the union
   * can lie: per-resource fragmentation) and prices it.
   */
  async quote(request: SlotSelectionRequest & { memberId: string; now?: Date }): Promise<QuoteResult> {
    const now = request.now ?? new Date();
    const type = await this.getActiveType(request.typeCode);
    await this.assertTier(request.memberId, type);

    const { startMinutes, durationMinutes } = parseSlotSelection(request.slots, this.gridConfig(type));
    this.assertWithinHorizon(type, request.date, now);
    const range = selectionToRange(request.date, startMinutes, this.gridConfig(type), this.timezone);
    if (range.startsAt <= now) throw new ReservationInPastError();

    await this.assertUnderDailyLimit(undefined, type, request.memberId, request.date);

    const { candidateIds } = await this.candidateResources(type, request.date, startMinutes);
    if (candidateIds.length === 0) throw new SlotUnavailableError();

    return {
      typeCode: type.code,
      date: request.date,
      slots: startMinutes.map(minutesToTimeLabel),
      durationMinutes,
      hourlyRateCents: type.hourlyRateCents,
      totalCents: computeTotalCents(type.hourlyRateCents, durationMinutes),
    };
  }

  // ── Create (checkout) ──

  /**
   * The checkout write. No hold exists before this call; ONE transaction per
   * candidate resource inserts the reservation as pending_payment plus its
   * active claim with the hold TTL, letting the exclusion constraint
   * arbitrate. On 23P01 the next candidate is tried, then "slot just taken".
   * The PaymentIntent is created OUTSIDE the transaction.
   *
   * Admin-created reservations (organizer = the target member,
   * createdByAdminId set) are comp: confirmed immediately, no hold, no
   * payment.
   */
  async create(request: {
    typeCode: string;
    date: string;
    slots: string[];
    organizerId: string;
    inviteeMemberIds?: string[];
    clubId?: string | null;
    actorId?: string;
    admin?: { adminUserId: string };
    /** Pin to one resource (admin compat routes book a named court). */
    resourceId?: string;
    now?: Date;
  }): Promise<CreateReservationResult> {
    const now = request.now ?? new Date();
    const type = await this.getActiveType(request.typeCode);
    if (!request.admin) {
      // Admin bookings may comp a facility past the tier gate; members not.
      await this.assertTier(request.organizerId, type);
    }
    if (!(await this.membershipChecker.hasActiveMembership(request.organizerId))) {
      throw new InactiveMembershipError();
    }

    const { startMinutes, durationMinutes } = parseSlotSelection(request.slots, this.gridConfig(type));
    this.assertWithinHorizon(type, request.date, now);
    const range = selectionToRange(request.date, startMinutes, this.gridConfig(type), this.timezone);
    if (range.startsAt <= now) throw new ReservationInPastError();

    const inviteeIds = [...new Set(request.inviteeMemberIds ?? [])].filter(
      (id) => id !== request.organizerId,
    );
    if (inviteeIds.length > 0) {
      const existing = await this.reservationRepo.filterExistingMemberIds(inviteeIds);
      const missing = inviteeIds.filter((id) => !existing.has(id));
      if (missing.length > 0) throw new InviteeNotFoundError(missing);
    }

    const totalCents = computeTotalCents(type.hourlyRateCents, durationMinutes);
    const actorId = request.actorId ?? request.organizerId;
    let { candidateIds } = await this.candidateResources(type, request.date, startMinutes);
    if (request.resourceId) {
      candidateIds = candidateIds.filter((candidate) => candidate === request.resourceId);
    }
    if (candidateIds.length === 0) throw new SlotUnavailableError();

    const holdExpiresAt = request.admin ? null : new Date(now.getTime() + this.holdMinutes * 60_000);
    let created: ReservationDetailRecord | null = null;

    for (const resourceId of candidateIds) {
      try {
        created = await this.uow.execute(async (tx) => {
          await this.reservationRepo.advisoryLockMember(tx, request.organizerId);
          await this.assertUnderDailyLimit(tx, type, request.organizerId, request.date);
          await this.releaseExpiredHoldsWithAudit(tx, [resourceId], now);

          const detail = await this.reservationRepo.createWithClaim(tx, {
            resourceTypeId: type.id,
            resourceId,
            organizerId: request.organizerId,
            clubId: request.clubId ?? null,
            startsAt: range.startsAt,
            endsAt: range.endsAt,
            localDate: request.date,
            status: request.admin ? 'confirmed' : 'pending_payment',
            hourlyRateCentsSnapshot: type.hourlyRateCents,
            createdByAdminId: request.admin?.adminUserId ?? null,
            holdExpiresAt,
            participants: [
              { memberId: request.organizerId, role: 'organizer', status: 'confirmed' },
              ...inviteeIds.map((memberId) => ({
                memberId,
                role: 'guest' as const,
                status: 'pending' as const,
                invitedById: request.organizerId,
              })),
            ],
          });

          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: detail.id,
            eventType: 'reservation.created',
            data: {
              reference: detail.reference,
              typeCode: type.code,
              resourceId,
              startsAt: range.startsAt.toISOString(),
              endsAt: range.endsAt.toISOString(),
              localDate: request.date,
              totalCents,
              status: detail.status,
              createdByAdminId: request.admin?.adminUserId ?? null,
            },
            actorId,
          });
          for (const memberId of inviteeIds) {
            await this.audit.append(tx, {
              streamType: STREAM_TYPE,
              streamId: detail.id,
              eventType: 'reservation.participant_invited',
              data: { memberId, invitedById: request.organizerId },
              actorId,
            });
          }

          return detail;
        });
        break;
      } catch (error) {
        if (error instanceof SlotUnavailableError) continue; // next candidate
        throw error;
      }
    }

    if (!created) throw new SlotUnavailableError();

    if (request.admin) {
      return { reservation: created, clientSecret: null, holdExpiresAt: null, totalCents };
    }

    // Stripe lives OUTSIDE the booking transaction. If the intent cannot be
    // created the hold is released immediately instead of squatting the slot
    // for the TTL.
    let intent;
    try {
      intent = await this.paymentPort.createPaymentIntent({
        reservationId: created.id,
        memberId: request.organizerId,
        amountCents: totalCents,
        attempt: 1,
      });
    } catch (error) {
      await this.uow.execute(async (tx) => {
        await this.reservationRepo.releaseClaim(tx, created!.id);
        await this.reservationRepo.updateStatus(tx, created!.id, 'expired');
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: created!.id,
          eventType: 'reservation.expired',
          data: { reason: 'payment_setup_failed' },
          actorId,
        });
      });
      throw error;
    }

    await this.uow.execute(async (tx) => {
      await this.reservationRepo.addPayment(tx, {
        reservationId: created!.id,
        kind: 'charge',
        amountCents: totalCents,
        stripePaymentIntentId: intent.paymentIntentId,
        status: 'pending',
      });
    });

    return {
      reservation: (await this.reservationRepo.getDetail(created.id))!,
      clientSecret: intent.clientSecret,
      holdExpiresAt,
      totalCents,
    };
  }

  // ── Confirm ──

  /**
   * Asserts payment success through the payment port and flips the
   * reservation to confirmed. Idempotent: confirming a confirmed reservation
   * is a no-op success. TODO(package-c): the payment_intent.succeeded webhook
   * calls the same path so a died client cannot lose a paid booking.
   */
  async confirm(id: string, viewer: { memberId?: string; actorId?: string }): Promise<ReservationDetailRecord> {
    const detail = await this.getOwn(id, viewer.memberId);
    if (detail.status === 'confirmed') return detail;
    if (detail.status === 'expired') throw new HoldExpiredError();
    if (detail.status !== 'pending_payment') {
      throw new InvalidReservationStatusError(detail.status, 'pending_payment');
    }

    const charge = [...detail.payments].reverse().find((payment) => payment.kind === 'charge');
    if (!charge?.stripePaymentIntentId) throw new PaymentNotCompletedError();
    const paymentStatus = await this.paymentPort.getPaymentStatus(charge.stripePaymentIntentId);
    if (paymentStatus !== 'succeeded') throw new PaymentNotCompletedError();

    await this.uow.execute(async (tx) => {
      const fresh = await this.reservationRepo.getDetail(id, tx);
      if (!fresh || fresh.status === 'confirmed') return; // lost an idempotent race
      if (fresh.status !== 'pending_payment') throw new HoldExpiredError();

      await this.reservationRepo.confirmReservation(tx, id, fresh.amountPaidCents + charge.amountCents);
      await this.reservationRepo.setPaymentStatus(tx, charge.id, 'succeeded');
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.payment_captured',
        data: { amountCents: charge.amountCents, stripePaymentIntentId: charge.stripePaymentIntentId },
        actorId: viewer.actorId ?? viewer.memberId,
      });
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.confirmed',
        data: { reference: fresh.reference },
        actorId: viewer.actorId ?? viewer.memberId,
      });
    });

    return (await this.reservationRepo.getDetail(id))!;
  }

  // ── Reads ──

  /** Detail for a participant; non-participants get a 404-shaped error. */
  async getForViewer(
    id: string,
    viewerMemberId: string,
  ): Promise<{ reservation: ReservationDetailRecord; viewer: ViewerContext }> {
    const detail = await this.reservationRepo.getDetail(id);
    if (!detail) throw new ReservationNotFoundError(id);
    const participant = detail.participants.find((row) => row.memberId === viewerMemberId);
    if (!participant) throw new ReservationNotFoundError(id);

    return {
      reservation: detail,
      viewer: {
        role: participant.role,
        status: participant.status,
        canInvite: canManageInvites(participant) && isActiveReservationStatus(detail.status),
        canManage: participant.role === 'organizer',
        canRespond: participant.role === 'guest' && isActiveReservationStatus(detail.status),
      },
    };
  }

  async listForMember(memberId: string, filter: 'upcoming' | 'past' | 'all' = 'upcoming') {
    return this.reservationRepo.listForMember(memberId, filter);
  }

  async listAll(options: { localDate?: string; includeInactive?: boolean } = {}) {
    return this.reservationRepo.listAll(options);
  }

  async countUpcomingForResources(resourceIds: string[]) {
    return this.reservationRepo.countUpcomingForResources(resourceIds);
  }

  // ── Reschedule ──

  async rescheduleQuote(
    id: string,
    organizerId: string,
    change: { date: string; slots: string[] },
    now: Date = new Date(),
  ): Promise<RescheduleQuoteResult> {
    const detail = await this.getOwn(id, organizerId);
    if (detail.status !== 'confirmed') {
      throw new InvalidReservationStatusError(detail.status, 'confirmed');
    }
    const type = detail.resourceType;
    const { startMinutes, durationMinutes } = parseSlotSelection(change.slots, this.gridConfig(type));
    this.assertWithinHorizon(type, change.date, now);
    const range = selectionToRange(change.date, startMinutes, this.gridConfig(type), this.timezone);
    if (range.startsAt <= now) throw new ReservationInPastError();

    const { candidateIds } = await this.candidateResources(type, change.date, startMinutes, {
      excludeReservationId: id,
    });
    if (candidateIds.length === 0) throw new SlotUnavailableError();

    const netPaidCents = computeNetPaidCents(detail.payments);
    const newTotalCents = computeTotalCents(detail.hourlyRateCentsSnapshot, durationMinutes);

    return {
      date: change.date,
      slots: startMinutes.map(minutesToTimeLabel),
      durationMinutes,
      newTotalCents,
      netPaidCents,
      deltaCents: newTotalCents - netPaidCents,
    };
  }

  /**
   * Atomic claim-range UPDATE (self-excluding by construction of the
   * exclusion constraint), guest reset and audit in one transaction per
   * candidate resource; money delta settled after commit at the snapshot
   * rate.
   */
  async reschedule(
    id: string,
    organizerId: string,
    change: { date: string; slots: string[] },
    actorId?: string,
    now: Date = new Date(),
  ): Promise<{ reservation: ReservationDetailRecord; deltaCents: number; clientSecret: string | null }> {
    const quote = await this.rescheduleQuote(id, organizerId, change, now);
    const detail = await this.getOwn(id, organizerId);
    const type = detail.resourceType;
    const { startMinutes } = parseSlotSelection(change.slots, this.gridConfig(type));
    const range = selectionToRange(change.date, startMinutes, this.gridConfig(type), this.timezone);

    const { candidateIds } = await this.candidateResources(type, change.date, startMinutes, {
      excludeReservationId: id,
    });
    // Prefer keeping the same resource; a pure time shift then never moves courts.
    const ordered = [
      ...candidateIds.filter((candidate) => candidate === detail.resourceId),
      ...candidateIds.filter((candidate) => candidate !== detail.resourceId),
    ];
    if (ordered.length === 0) throw new SlotUnavailableError();

    const actor = actorId ?? organizerId;
    let moved = false;

    for (const resourceId of ordered) {
      try {
        await this.uow.execute(async (tx) => {
          await this.reservationRepo.advisoryLockMember(tx, organizerId);
          const fresh = await this.reservationRepo.getDetail(id, tx);
          if (!fresh || fresh.status !== 'confirmed') {
            throw new InvalidReservationStatusError(fresh?.status ?? 'missing', 'confirmed');
          }
          await this.assertUnderDailyLimit(tx, type, organizerId, change.date, id);
          await this.releaseExpiredHoldsWithAudit(tx, [resourceId], now);

          await this.reservationRepo.moveClaimAndReservation(tx, {
            reservationId: id,
            resourceId,
            startsAt: range.startsAt,
            endsAt: range.endsAt,
            localDate: change.date,
          });
          const resetMemberIds = await this.reservationRepo.resetConfirmedGuestsToPending(tx, id);
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: id,
            eventType: 'reservation.rescheduled',
            data: {
              from: { startsAt: fresh.startsAt.toISOString(), endsAt: fresh.endsAt.toISOString(), resourceId: fresh.resourceId },
              to: { startsAt: range.startsAt.toISOString(), endsAt: range.endsAt.toISOString(), resourceId },
              deltaCents: quote.deltaCents,
              resetParticipants: resetMemberIds,
            },
            actorId: actor,
          });
        });
        moved = true;
        break;
      } catch (error) {
        if (error instanceof SlotUnavailableError) continue;
        throw error;
      }
    }

    if (!moved) throw new SlotUnavailableError();

    let clientSecret: string | null = null;
    if (quote.deltaCents > 0) {
      // Grow: a new on-session PaymentIntent for the difference.
      // TODO(package-c): confirmation of the delta charge rides the same
      // webhook seam as the initial payment.
      const intent = await this.paymentPort.createPaymentIntent({
        reservationId: id,
        memberId: organizerId,
        amountCents: quote.deltaCents,
        attempt: detail.payments.length + 1,
      });
      await this.uow.execute(async (tx) => {
        await this.reservationRepo.addPayment(tx, {
          reservationId: id,
          kind: 'charge',
          amountCents: quote.deltaCents,
          stripePaymentIntentId: intent.paymentIntentId,
          status: 'pending',
        });
      });
      clientSecret = intent.clientSecret;
    } else if (quote.deltaCents < 0) {
      await this.applyRefund(id, detail.payments, -quote.deltaCents, actor);
    }

    return {
      reservation: (await this.reservationRepo.getDetail(id))!,
      deltaCents: quote.deltaCents,
      clientSecret,
    };
  }

  // ── Cancel ──

  /**
   * Cancel with the tiered refund policy (100% >24h, 50% 2-24h, 0% inside).
   * Admin and event-conflict cancellations refund in full: the club
   * cancelled, not the member.
   */
  async cancel(
    id: string,
    options: { memberId?: string; fullRefund?: boolean; actorId?: string; now?: Date } = {},
  ): Promise<{ refundCents: number }> {
    const now = options.now ?? new Date();
    const detail = await this.getOwn(id, options.memberId);
    if (!isActiveReservationStatus(detail.status)) {
      throw new InvalidReservationStatusError(detail.status, 'pending_payment or confirmed');
    }
    if (!options.fullRefund && now >= detail.startsAt) throw new ReservationAlreadyStartedError();

    const actor = options.actorId ?? options.memberId;
    const percent = options.fullRefund ? 100 : refundPercentFor(detail.startsAt, now);
    const netPaidCents = computeNetPaidCents(detail.payments);
    const refundCents = detail.status === 'confirmed' ? computeRefundCents(netPaidCents, percent) : 0;

    await this.uow.execute(async (tx) => {
      const fresh = await this.reservationRepo.getDetail(id, tx);
      if (!fresh || !isActiveReservationStatus(fresh.status)) {
        throw new InvalidReservationStatusError(fresh?.status ?? 'missing', 'pending_payment or confirmed');
      }
      await this.reservationRepo.releaseClaim(tx, id);
      await this.reservationRepo.updateStatus(tx, id, 'cancelled');
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.cancelled',
        data: { refundCents, refundPercent: percent, previousStatus: fresh.status },
        actorId: actor,
      });
    });

    if (detail.status === 'pending_payment') {
      // Best effort: an uncaptured intent left behind is cleaned up by
      // billing reconciliation if this fails.
      const pendingCharge = [...detail.payments].reverse().find((payment) => payment.kind === 'charge');
      if (pendingCharge?.stripePaymentIntentId) {
        await this.paymentPort.cancelPaymentIntent(pendingCharge.stripePaymentIntentId).catch(() => {});
      }
      return { refundCents: 0 };
    }

    if (refundCents > 0) {
      await this.applyRefund(id, detail.payments, refundCents, actor);
    }
    return { refundCents };
  }

  // ── Participants ──

  /**
   * Invitation transitions. Rechecks the reservation status inside the
   * transaction: an accept in flight while the organizer cancels must lose.
   */
  async respond(
    id: string,
    memberId: string,
    response: ParticipantResponse,
    actorId?: string,
  ): Promise<{ status: string }> {
    const now = new Date();
    return this.uow.execute(async (tx) => {
      const detail = await this.reservationRepo.getDetail(id, tx);
      if (!detail) throw new ReservationNotFoundError(id);
      const participant = detail.participants.find((row) => row.memberId === memberId);
      if (!participant) throw new ReservationNotFoundError(id);
      if (!isActiveReservationStatus(detail.status)) {
        throw new InvalidReservationStatusError(detail.status, 'pending_payment or confirmed');
      }

      const next = applyParticipantResponse(participant, response);
      if (next === participant.status) return { status: next }; // idempotent

      await this.reservationRepo.updateParticipantStatus(tx, participant.id, next, now);
      const eventType =
        next === 'confirmed'
          ? 'reservation.invite_accepted'
          : next === 'withdrawn'
            ? 'reservation.participant_withdrawn'
            : 'reservation.invite_declined';
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType,
        data: { memberId, previousStatus: participant.status },
        actorId: actorId ?? memberId,
      });

      return { status: next };
    });
  }

  /** Invite permission: organizer + confirmed participants (decision 6). */
  async addParticipants(
    id: string,
    viewerMemberId: string,
    memberIds: string[],
    actorId?: string,
  ): Promise<{ invited: string[] }> {
    const requested = [...new Set(memberIds)];
    const existing = await this.reservationRepo.filterExistingMemberIds(requested);
    const missing = requested.filter((memberId) => !existing.has(memberId));
    if (missing.length > 0) throw new InviteeNotFoundError(missing);

    return this.uow.execute(async (tx) => {
      const detail = await this.reservationRepo.getDetail(id, tx);
      if (!detail) throw new ReservationNotFoundError(id);
      const viewer = detail.participants.find((row) => row.memberId === viewerMemberId);
      if (!viewer) throw new ReservationNotFoundError(id);
      if (!canManageInvites(viewer)) throw new NotInvitePermittedError();
      if (!isActiveReservationStatus(detail.status)) {
        throw new InvalidReservationStatusError(detail.status, 'pending_payment or confirmed');
      }

      const invited: string[] = [];
      for (const memberId of requested) {
        if (memberId === detail.organizerId) continue;
        const current = detail.participants.find((row) => row.memberId === memberId);
        // "Add all" hitting an already-invited member is a no-op, not a dup.
        if (current && (current.status === 'pending' || current.status === 'confirmed')) continue;

        await this.reservationRepo.upsertPendingInvite(tx, {
          reservationId: id,
          memberId,
          invitedById: viewerMemberId,
        });
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: id,
          eventType: 'reservation.participant_invited',
          data: { memberId, invitedById: viewerMemberId, reinvite: Boolean(current) },
          actorId: actorId ?? viewerMemberId,
        });
        invited.push(memberId);
      }

      return { invited };
    });
  }

  async removeParticipant(
    id: string,
    organizerId: string,
    targetMemberId: string,
    actorId?: string,
  ): Promise<void> {
    await this.uow.execute(async (tx) => {
      const detail = await this.reservationRepo.getDetail(id, tx);
      if (!detail || detail.organizerId !== organizerId) throw new ReservationNotFoundError(id);
      const target = detail.participants.find((row) => row.memberId === targetMemberId);
      if (!target) throw new ParticipantNotFoundError();
      if (target.role === 'organizer') throw new CannotRemoveOrganizerError();

      await this.reservationRepo.deleteParticipant(tx, target.id);
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.participant_removed',
        data: { memberId: targetMemberId },
        actorId: actorId ?? organizerId,
      });
    });
  }

  // ── Sweeper (cron) ──

  /**
   * Expire stale pending_payment holds, but check the PaymentIntent first:
   * a hold whose payment actually succeeded is confirmed, never expired.
   */
  async expireStaleHolds(now: Date = new Date()): Promise<{ expired: number; confirmed: number }> {
    const holds = await this.reservationRepo.listExpiredHolds(now);
    let expired = 0;
    let confirmed = 0;

    for (const hold of holds) {
      const charge = [...hold.payments].reverse().find((payment) => payment.kind === 'charge');
      const paymentStatus = charge?.stripePaymentIntentId
        ? await this.paymentPort.getPaymentStatus(charge.stripePaymentIntentId)
        : 'failed';

      if (paymentStatus === 'succeeded' && charge) {
        await this.uow.execute(async (tx) => {
          const fresh = await this.reservationRepo.getDetail(hold.id, tx);
          if (!fresh || fresh.status !== 'pending_payment') return;
          await this.reservationRepo.confirmReservation(tx, hold.id, fresh.amountPaidCents + charge.amountCents);
          await this.reservationRepo.setPaymentStatus(tx, charge.id, 'succeeded');
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: hold.id,
            eventType: 'reservation.confirmed',
            data: { reference: fresh.reference, via: 'sweeper' },
            source: 'sweeper',
          });
        });
        confirmed += 1;
        continue;
      }

      await this.uow.execute(async (tx) => {
        const fresh = await this.reservationRepo.getDetail(hold.id, tx);
        if (!fresh || fresh.status !== 'pending_payment') return;
        await this.reservationRepo.releaseClaim(tx, hold.id);
        await this.reservationRepo.updateStatus(tx, hold.id, 'expired');
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: hold.id,
          eventType: 'reservation.expired',
          data: { reason: 'hold_ttl' },
          source: 'sweeper',
        });
      });
      if (charge?.stripePaymentIntentId) {
        await this.paymentPort.cancelPaymentIntent(charge.stripePaymentIntentId).catch(() => {});
      }
      expired += 1;
    }

    return { expired, confirmed };
  }

  // ── Internals ──

  private gridConfig(type: ResourceType): SlotGridConfig {
    return {
      slotDurationMinutes: type.slotDurationMinutes,
      opStartMinutes: type.opStartMinutes,
      opEndMinutes: type.opEndMinutes,
    };
  }

  private async getActiveType(code: string): Promise<ResourceType> {
    const type = await this.typeRepo.getByCode(code);
    if (!type || !type.active) throw new ResourceTypeNotFoundError(code);
    return type;
  }

  private async assertTier(memberId: string, type: ResourceType): Promise<void> {
    if (type.minTier === 'member') return;
    const tier = await this.membershipChecker.getTier(memberId);
    if (!tierSatisfies(tier, type.minTier)) throw new TierRequiredError(type.minTier);
  }

  private assertWithinHorizon(type: ResourceType, dateKey: string, now: Date): void {
    const todayKey = zonedDateKey(now, this.timezone);
    if (dateKey < todayKey) throw new ReservationInPastError();
    if (dateKey > addDaysToDateKey(todayKey, type.maxAdvanceDays)) {
      throw new ReservationTooFarInAdvanceError(type.maxAdvanceDays);
    }
  }

  private async assertUnderDailyLimit(
    tx: Parameters<ReservationRepository['countActiveOnDate']>[0],
    type: ResourceType,
    organizerId: string,
    localDate: string,
    excludeReservationId?: string,
  ): Promise<void> {
    const count = await this.reservationRepo.countActiveOnDate(tx, {
      organizerId,
      resourceTypeId: type.id,
      localDate,
      excludeReservationId,
    });
    if (count >= type.maxReservationsPerMemberPerDay) {
      throw new MaxReservationsExceededError(type.maxReservationsPerMemberPerDay);
    }
  }

  /**
   * Per-resource availability then single-resource fit, ordered by
   * displayOrder so the retry loop walks a stable candidate list.
   */
  private async candidateResources(
    type: ResourceType,
    dateKey: string,
    startMinutes: number[],
    options: { excludeReservationId?: string } = {},
  ): Promise<{ resources: Resource[]; candidateIds: string[] }> {
    const resources = await this.resourceRepo.listActiveByType(type.id);
    if (resources.length === 0) return { resources, candidateIds: [] };

    const windowFrom = wallTimeToUtc(dateKey, 0, this.timezone);
    const windowTo = wallTimeToUtc(dateKey, type.opEndMinutes, this.timezone);
    const claims = await this.claimRepo.listActiveInWindow(
      resources.map((resource) => resource.id),
      windowFrom,
      windowTo,
      options,
    );

    const perResource = freeSlotStartsByResource({
      dateKey,
      config: this.gridConfig(type),
      resourceIds: resources.map((resource) => resource.id),
      claims,
      timeZone: this.timezone,
    });

    return {
      resources,
      candidateIds: resourcesFreeForSelection(
        perResource,
        startMinutes,
        resources.map((resource) => resource.id),
      ),
    };
  }

  /** Loads a reservation the given member organizes; 404-shaped otherwise. */
  private async getOwn(id: string, memberId?: string): Promise<ReservationDetailRecord> {
    const detail = await this.reservationRepo.getDetail(id);
    if (!detail) throw new ReservationNotFoundError(id);
    if (memberId && detail.organizerId !== memberId) throw new ReservationNotFoundError(id);
    return detail;
  }

  private async releaseExpiredHoldsWithAudit(
    tx: Parameters<ReservationRepository['forceReleaseExpiredHolds']>[0],
    resourceIds: string[],
    now: Date,
  ): Promise<void> {
    const releasedIds = await this.reservationRepo.forceReleaseExpiredHolds(tx, resourceIds, now);
    for (const reservationId of releasedIds) {
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: reservationId,
        eventType: 'reservation.expired',
        data: { reason: 'hold_ttl_force_release' },
      });
    }
  }

  /**
   * Refund against the newest charges with refundable balance, applied
   * optimistically; package C reconciles through refund webhooks.
   */
  private async applyRefund(
    reservationId: string,
    payments: ReservationPayment[],
    refundCents: number,
    actorId?: string,
  ): Promise<void> {
    const allocations = allocateRefund(payments, refundCents);
    for (const allocation of allocations) {
      const { refundId } = await this.paymentPort.refund({
        paymentIntentId: allocation.stripePaymentIntentId,
        amountCents: allocation.amountCents,
        reservationId,
      });
      await this.uow.execute(async (tx) => {
        await this.reservationRepo.addPayment(tx, {
          reservationId,
          kind: 'refund',
          amountCents: allocation.amountCents,
          stripePaymentIntentId: allocation.stripePaymentIntentId,
          stripeRefundId: refundId,
          status: 'succeeded',
        });
        await this.reservationRepo.adjustAmountPaid(tx, reservationId, -allocation.amountCents);
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: reservationId,
          eventType: 'reservation.payment_refunded',
          data: { amountCents: allocation.amountCents, stripeRefundId: refundId },
          actorId,
        });
      });
    }
  }
}
