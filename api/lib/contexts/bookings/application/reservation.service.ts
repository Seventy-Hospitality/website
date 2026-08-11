import type { TransactionContext, UnitOfWork } from '@/lib/kernel';
import {
  addDaysToDateKey,
  minutesToTimeLabel,
  wallTimeToUtc,
  zonedDateKey,
  zonedMinutesSinceMidnight,
} from '@/lib/kernel';
import {
  type ActivityStats,
  type BookingPaymentPort,
  type ClubRosterPort,
  type MembershipChecker,
  type ParticipantResponse,
  type ReservationPayment,
  type Resource,
  type ResourceType,
  type SlotGridConfig,
  aggregateActivityStats,
  applyParticipantResponse,
  allocateRefund,
  canManageInvites,
  computeNetPaidCents,
  computeRefundableCents,
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
  ClubInviteNotAllowedError,
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
  ReservationChangedError,
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

/**
 * How old a pending, unstamped reserved refund must be before the nightly
 * re-drive touches it: long enough that no live phase-2 execution can still
 * be in flight, short enough that Stripe's ~24h idempotency-key window
 * comfortably covers a re-issue against a call that actually succeeded.
 */
const STALE_REFUND_RETRY_MINUTES = 60;

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

interface ReservedRefund {
  paymentId: string;
  stripePaymentIntentId: string | null;
  amountCents: number;
}

type ConfirmOutcome = 'confirmed' | 'already_confirmed' | 'lost';

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
    /** Clubs seam (package D); club-chip invites fail closed without it. */
    private readonly clubRoster?: ClubRosterPort,
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
   * and (for today) already-started slots. Expired-but-unswept holds read as
   * free (the booking path reclaims them). `excludeReservationId` is the
   * edit screen's self-exclusion: the reservation's own claim does not block
   * it.
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
      { excludeReservationId: params.excludeReservationId, now },
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
   * limit or horizon filtering: staff see the raw physical availability
   * (minus dead holds, which are functionally free).
   */
  async getResourceAvailability(
    resourceId: string,
    dateKey: string,
    now: Date = new Date(),
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
      { now },
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

    const { candidateIds } = await this.candidateResources(type, request.date, startMinutes, { now });
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
   * Expired holds on the type's resources are reclaimed payment-aware BEFORE
   * candidates are computed (a paid one is confirmed, a dead one released),
   * so a slot squatted by an abandoned hold is deterministically bookable
   * between sweeper runs. The PaymentIntent is created OUTSIDE the
   * transaction.
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
    /**
     * Club chips: each club expands to its CURRENT member set at invite
     * time (snapshot; later joins do not join the reservation), with
     * viaClubId provenance on every expanded participant. Only clubs the
     * organizer belongs to are accepted. The first club becomes the
     * reservation's club linkage (the group-activity feed).
     */
    inviteeClubIds?: string[];
    clubId?: string | null;
    actorId?: string;
    admin?: { adminUserId: string };
    /** Pin to one resource (admin compat routes book a named court). */
    resourceId?: string;
    /** Weekly-series materialization provenance (cron; rides admin comp). */
    seriesId?: string | null;
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

    // Club chips expand BEFORE the transaction (snapshot semantics). A
    // directly-picked member wins provenance over their club membership;
    // club rosters need no existence check (they ARE member rows).
    const clubInvitees = await this.expandClubInvitees(
      request.inviteeClubIds ?? [],
      request.organizerId,
    );
    for (const id of inviteeIds) clubInvitees.delete(id);
    const clubId = request.clubId ?? request.inviteeClubIds?.[0] ?? null;

    const totalCents = computeTotalCents(type.hourlyRateCents, durationMinutes);
    const actorId = request.actorId ?? request.organizerId;

    const resources = await this.resourceRepo.listActiveByType(type.id);
    await this.sweepExpiredHolds(resources.map((resource) => resource.id), now, 'reclaim');

    let { candidateIds } = await this.candidateResources(type, request.date, startMinutes, { now });
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
          // Backstop for holds that expired between the sweep above and this
          // transaction; a hold confirmed mid-race is skipped (CAS inside).
          await this.releaseExpiredHoldsWithAudit(tx, [resourceId], now);

          const detail = await this.reservationRepo.createWithClaim(tx, {
            resourceTypeId: type.id,
            resourceId,
            organizerId: request.organizerId,
            clubId,
            seriesId: request.seriesId ?? null,
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
              ...[...clubInvitees].map(([memberId, viaClubId]) => ({
                memberId,
                role: 'guest' as const,
                status: 'pending' as const,
                invitedById: request.organizerId,
                viaClubId,
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
              clubId,
              seriesId: request.seriesId ?? null,
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
          for (const [memberId, viaClubId] of clubInvitees) {
            await this.audit.append(tx, {
              streamType: STREAM_TYPE,
              streamId: detail.id,
              eventType: 'reservation.participant_invited',
              data: { memberId, invitedById: request.organizerId, viaClubId },
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
    // for the TTL (guarded transition: audit only when we actually expired).
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
        await this.reservationRepo.advisoryLockReservation(tx, created!.id);
        const expired = await this.reservationRepo.transitionStatus(
          tx,
          created!.id,
          ['pending_payment'],
          'expired',
        );
        if (!expired) return;
        await this.reservationRepo.releaseClaim(tx, created!.id);
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
   * The single "payment succeeded" entry point (client confirm now; the
   * package-C payment_intent.succeeded webhook calls the same path).
   * Handles, idempotently and race-safely:
   *  - a pending_payment hold whose intent succeeded -> confirmed (exactly
   *    one of client/webhook/sweeper wins the compare-and-set and appends
   *    the audit events);
   *  - a confirmed reservation with a PAID pending reschedule-grow -> the
   *    claim move is applied now (or the delta refunded if the slot is gone);
   *  - an EXPIRED reservation whose intent succeeded (client died, webhook
   *    lag, force-released hold) -> the slot is re-acquired and confirmed,
   *    or the captured charge is refunded in full. A paid booking is never
   *    silently lost and a captured charge is never stranded.
   */
  async confirm(
    id: string,
    viewer: { memberId?: string; actorId?: string; source?: string },
  ): Promise<ReservationDetailRecord> {
    const detail = await this.getOwn(id, viewer.memberId);
    const actorId = viewer.actorId ?? viewer.memberId;
    const source = viewer.source;

    if (detail.status === 'confirmed') {
      if (!detail.pendingChange) return detail;
      return this.settlePendingChange(detail, { actorId, source });
    }
    if (detail.status === 'expired') {
      return this.recoverExpiredIfPaid(detail, { actorId, source });
    }
    if (detail.status !== 'pending_payment') {
      throw new InvalidReservationStatusError(detail.status, 'pending_payment');
    }

    const charge = [...detail.payments].reverse().find((payment) => payment.kind === 'charge');
    if (!charge?.stripePaymentIntentId) throw new PaymentNotCompletedError();
    const paymentStatus = await this.paymentPort.getPaymentStatus(charge.stripePaymentIntentId);
    if (paymentStatus !== 'succeeded') throw new PaymentNotCompletedError();

    const outcome = await this.settlePendingConfirmation(id, charge, { actorId, source });
    if (outcome === 'lost') {
      // A concurrent cancel or expiry beat us; surface the truth.
      const fresh = await this.reservationRepo.getDetail(id);
      if (fresh?.status === 'confirmed') return fresh;
      if (fresh?.status === 'expired') return this.recoverExpiredIfPaid(fresh, { actorId, source });
      if (fresh?.status === 'cancelled') {
        throw new InvalidReservationStatusError('cancelled', 'pending_payment');
      }
      throw new HoldExpiredError();
    }
    return (await this.reservationRepo.getDetail(id))!;
  }

  // ── Billing-context entry points (webhook + reconcile cron) ──

  /**
   * The billing context's "this PaymentIntent captured" entry point
   * (payment_intent.succeeded webhook and the nightly reconcile sweep). It
   * settles through the SAME paths as a client confirm, plus the two cases
   * confirm() cannot reach:
   *
   * - a CANCELLED reservation whose charge captured in the sub-second
   *   window after cancel() judged the intent uncaptured (the pay-vs-drop
   *   TOCTOU residual recorded in decisions-scheduling.md item 20). That
   *   orphaned capture is refunded at the percent the cancellation applied;
   *   the tier-kept balance of an ordinary paid cancellation is never
   *   touched, because only charge rows not yet succeeded can be orphaned.
   * - a CONFIRMED reservation with a captured charge no live path will ever
   *   settle: a change delta whose parked change was superseded, dropped or
   *   swept while its intent captured. The capture is acknowledged and
   *   refunded IN FULL (the changed time was never delivered); the live
   *   pendingChange's own charge is excluded — confirm() applies that one.
   */
  async handleCapturedPayment(
    id: string,
    options: { source?: string; intent?: { paymentIntentId: string; amountCents: number } } = {},
  ): Promise<'confirmed' | 'already_settled' | 'orphan_refunded' | 'not_captured'> {
    let detail = await this.reservationRepo.getDetail(id);
    // Throwing NOT-FOUND is deliberate: payment_intent.succeeded can arrive
    // before the hold row is visible; the webhook 500s and Stripe retries.
    if (!detail) throw new ReservationNotFoundError(id);

    // A crash between the PI creation and the charge-row insert leaves a
    // live intent with no row; recreate it from the intent so every
    // settlement path below can see the money.
    if (options.intent && !detail.payments.some(
      (payment) => payment.stripePaymentIntentId === options.intent!.paymentIntentId,
    )) {
      await this.uow.execute(async (tx) => {
        await this.reservationRepo.advisoryLockReservation(tx, id);
        const existing = await this.reservationRepo.findChargeByPaymentIntent(
          tx,
          id,
          options.intent!.paymentIntentId,
        );
        if (existing) return; // raced another recreator
        await this.reservationRepo.addPayment(tx, {
          reservationId: id,
          kind: 'charge',
          amountCents: options.intent!.amountCents,
          stripePaymentIntentId: options.intent!.paymentIntentId,
          status: 'pending',
        });
      });
      detail = (await this.reservationRepo.getDetail(id))!;
    }

    if (detail.status === 'cancelled') {
      return this.refundOrphanedCapture(detail, options);
    }

    if (detail.status === 'confirmed') {
      const orphan = await this.refundOrphanedCaptureOnConfirmed(detail, options);
      if (orphan === 'orphan_refunded') return orphan;
      // 'none': fall through to confirm(), which applies a live paid
      // pending change or no-ops idempotently.
    }

    try {
      await this.confirm(id, { source: options.source ?? 'webhook' });
      return 'confirmed';
    } catch (error) {
      if (error instanceof InvalidReservationStatusError) {
        // A concurrent cancel raced us between the read and the confirm:
        // re-dispatch so a captured charge is never stranded.
        const fresh = await this.reservationRepo.getDetail(id);
        if (fresh?.status === 'cancelled') return this.refundOrphanedCapture(fresh, options);
        return 'already_settled';
      }
      if (error instanceof HoldExpiredError) {
        // Expired and either not actually paid or already made whole by the
        // recovery refund; a settled terminal state, never a webhook 500.
        return 'already_settled';
      }
      if (error instanceof PaymentNotCompletedError) {
        return 'not_captured'; // stale event; nothing captured
      }
      throw error;
    }
  }

  /**
   * Async-refund finalization (refund.updated / charge.refunded): Stripe
   * refunds can fail AFTER refunds.create succeeded. A failed refund flips
   * the row back and restores the paid total so the ledger matches reality;
   * the schedule change it belonged to stands (settled design: apply
   * optimistically, escalate to staff on failure).
   */
  async reconcileRefundOutcome(
    stripeRefundId: string,
    outcome: 'succeeded' | 'failed' | 'canceled',
    source = 'webhook',
  ): Promise<'reconciled' | 'unknown'> {
    const row = await this.reservationRepo.findPaymentByStripeRefundId(stripeRefundId);
    if (!row) return 'unknown';

    await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, row.reservationId);
      if (outcome === 'succeeded') {
        // Externally-recorded rows start pending; our own reserved rows are
        // already succeeded (completeRefund), so this is usually a no-op.
        await this.reservationRepo.setPaymentStatusIf(tx, row.id, 'pending', 'succeeded');
        return;
      }
      // A Stripe refund can fail AFTER refunds.create succeeded. Flip the
      // row back and restore the paid total so the ledger matches reality;
      // the schedule change it belonged to stands.
      const flippedSucceeded = await this.reservationRepo.setPaymentStatusIf(tx, row.id, 'succeeded', 'failed');
      const flippedPending = flippedSucceeded
        ? false
        : await this.reservationRepo.setPaymentStatusIf(tx, row.id, 'pending', 'failed');
      if (flippedSucceeded || flippedPending) {
        await this.reservationRepo.adjustAmountPaid(tx, row.reservationId, row.amountCents);
        // TODO(package-f): notify staff; an async-failed refund needs a human.
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: row.reservationId,
          eventType: 'reservation.refund_failed',
          data: { amountCents: row.amountCents, stripeRefundId, async: true },
          source,
        });
      }
    });
    return 'reconciled';
  }

  /**
   * A refund that did NOT originate here (staff goodwill refund from the
   * Stripe dashboard) must still consume refundable balance in the
   * settlement record, or a later cancel would allocate against an
   * already-refunded charge and fail at Stripe. Idempotent by
   * stripeRefundId under the reservation lock.
   *
   * A refund that DID originate here carries `refundKey` (its reserved
   * settlement-row id, stamped into Stripe metadata at refunds.create) and
   * is ADOPTED onto that row instead: until completeRefund stamps the
   * stripeRefundId, the reserved row is invisible to the id lookup above,
   * and inserting a second row would double-decrement amountPaid and
   * double-consume refundable balance for one Stripe refund.
   */
  async recordExternalRefund(input: {
    stripeRefundId: string;
    stripePaymentIntentId: string | null;
    amountCents: number;
    status: 'pending' | 'succeeded' | 'failed';
    refundKey?: string | null;
    source?: string;
  }): Promise<'recorded' | 'known' | 'unmatched'> {
    if (await this.reservationRepo.findPaymentByStripeRefundId(input.stripeRefundId)) return 'known';
    if (input.refundKey && (await this.adoptReservedRefund(input.refundKey, input))) return 'known';
    if (!input.stripePaymentIntentId) return 'unmatched';
    const reservationId = await this.reservationRepo.findReservationIdByPaymentIntent(
      input.stripePaymentIntentId,
    );
    if (!reservationId) return 'unmatched';

    const recorded = await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, reservationId);
      if (await this.reservationRepo.findPaymentByStripeRefundId(input.stripeRefundId, tx)) return false;
      await this.reservationRepo.addPayment(tx, {
        reservationId,
        kind: 'refund',
        amountCents: input.amountCents,
        stripePaymentIntentId: input.stripePaymentIntentId,
        stripeRefundId: input.stripeRefundId,
        status: input.status,
      });
      if (input.status !== 'failed') {
        await this.reservationRepo.adjustAmountPaid(tx, reservationId, -input.amountCents);
      }
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: reservationId,
        eventType: 'reservation.external_refund_recorded',
        data: {
          amountCents: input.amountCents,
          stripeRefundId: input.stripeRefundId,
          status: input.status,
        },
        source: input.source ?? 'webhook',
      });
      return true;
    });
    return recorded ? 'recorded' : 'known';
  }

  /**
   * Links an externally-observed Stripe refund back to the reserved row it
   * originated from (refundKey = row id). Stamps the stripeRefundId
   * (compare-and-set on NULL) and applies the observed outcome:
   *
   * - succeeded on a pending row: flip it; the reserve already decremented
   *   amountPaid, so nothing else moves.
   * - succeeded on a FAILED row: the refunds.create "failure" was a
   *   transient that actually went through at Stripe; re-apply the
   *   decrement the failure handler restored.
   * - failed on a pending row: same flip-and-restore as
   *   reconcileRefundOutcome.
   *
   * Returns false when refundKey does not resolve to one of our refund
   * rows (the caller falls through to the external-record path).
   */
  private async adoptReservedRefund(
    refundKey: string,
    input: {
      stripeRefundId: string;
      status: 'pending' | 'succeeded' | 'failed';
      source?: string;
    },
  ): Promise<boolean> {
    const row = await this.reservationRepo.getPaymentById(refundKey);
    if (!row || row.kind !== 'refund') return false;
    if (row.stripeRefundId && row.stripeRefundId !== input.stripeRefundId) return false; // not this refund's row

    await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, row.reservationId);
      const stamped = await this.reservationRepo.adoptReservedRefund(tx, row.id, input.stripeRefundId);
      if (input.status === 'succeeded') {
        const flippedFromPending = await this.reservationRepo.setPaymentStatusIf(tx, row.id, 'pending', 'succeeded');
        if (
          !flippedFromPending &&
          (await this.reservationRepo.setPaymentStatusIf(tx, row.id, 'failed', 'succeeded'))
        ) {
          await this.reservationRepo.adjustAmountPaid(tx, row.reservationId, -row.amountCents);
        }
      } else if (input.status === 'failed') {
        if (await this.reservationRepo.setPaymentStatusIf(tx, row.id, 'pending', 'failed')) {
          await this.reservationRepo.adjustAmountPaid(tx, row.reservationId, row.amountCents);
        }
      }
      if (stamped) {
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: row.reservationId,
          eventType: 'reservation.reserved_refund_adopted',
          data: {
            amountCents: row.amountCents,
            stripeRefundId: input.stripeRefundId,
            status: input.status,
          },
          source: input.source ?? 'webhook',
        });
      }
    });
    return true;
  }

  /**
   * charge.dispute.created: freeze the reservation financially. The disputed
   * charge is excluded from refundable balance (allocateRefund skips it), so
   * every refund-producing path fails closed until staff resolve it.
   */
  async freezeChargeForDispute(
    stripePaymentIntentId: string,
    source = 'webhook',
    now: Date = new Date(),
  ): Promise<string[]> {
    const reservationIds = await this.reservationRepo.markChargeDisputed(stripePaymentIntentId, now);
    for (const reservationId of reservationIds) {
      await this.uow.execute(async (tx) => {
        // TODO(package-f): notify staff; a dispute always needs a human.
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: reservationId,
          eventType: 'reservation.dispute_opened',
          data: { stripePaymentIntentId },
          source,
        });
      });
    }
    return reservationIds;
  }

  /**
   * Billing-side blockers for account closure (package E): a member with a
   * refund in flight or an open dispute cannot be deleted yet.
   */
  async hasBlockingFinancialState(memberId: string): Promise<boolean> {
    const { pendingRefunds, disputedCharges } =
      await this.reservationRepo.countBlockingFinancialState(memberId);
    return pendingRefunds > 0 || disputedCharges > 0;
  }

  /**
   * The HARD half of the closure gate: an open dispute needs staff, while
   * pending refunds are soft (the deletion pipeline itself creates them
   * when it cancels future bookings, so re-checking them mid-pipeline
   * would wedge the very flow that made them).
   */
  async hasOpenDisputes(memberId: string): Promise<boolean> {
    const { disputedCharges } = await this.reservationRepo.countBlockingFinancialState(memberId);
    return disputedCharges > 0;
  }

  /** Lifetime activity stats for the account screen (definition in domain/activity-stats.ts). */
  async getLifetimeActivityStats(memberId: string): Promise<ActivityStats> {
    return aggregateActivityStats(await this.reservationRepo.aggregateLifetimeStatsForMember(memberId));
  }

  // ── Account-deletion seams (package E's pipeline consumes these) ──

  /**
   * Cancels the member's FUTURE reservations (organizer, startsAt strictly
   * in the future) at the normal tier refund policy. Re-lists on every run
   * and treats already-cancelled/started/missing rows as done, so a
   * resumed pipeline converges without double work. A reservation
   * currently under way is court time being consumed and is left alone.
   */
  async cancelFutureReservationsForMember(
    memberId: string,
    actorId?: string,
    now: Date = new Date(),
  ): Promise<{ cancelled: number; refundCents: number }> {
    const upcoming = await this.reservationRepo.listForMember(memberId, 'upcoming', now);
    let cancelled = 0;
    let refundCents = 0;
    for (const detail of upcoming) {
      if (detail.organizerId !== memberId) continue;
      if (detail.startsAt.getTime() <= now.getTime()) continue;
      if (!isActiveReservationStatus(detail.status)) continue;
      try {
        const result = await this.cancel(detail.id, { memberId, actorId: actorId ?? memberId, now });
        cancelled += 1;
        refundCents += result.refundCents;
      } catch (err) {
        // Lost a race with another cancel/expiry: that outcome is the one
        // this step wanted anyway.
        if (
          err instanceof InvalidReservationStatusError ||
          err instanceof ReservationNotFoundError ||
          err instanceof ReservationAlreadyStartedError
        ) {
          continue;
        }
        throw err;
      }
    }
    return { cancelled, refundCents };
  }

  /**
   * Declines/withdraws the member's guest participations on OTHER members'
   * future reservations, so no organizer keeps a ghost "Deleted Member"
   * attendee. Pure DB, idempotent (respond() self-idempotents).
   */
  async releaseParticipationsForMember(
    memberId: string,
    actorId?: string,
    now: Date = new Date(),
  ): Promise<{ released: number }> {
    const upcoming = await this.reservationRepo.listForMember(memberId, 'upcoming', now);
    let released = 0;
    for (const detail of upcoming) {
      const participant = detail.participants.find((row) => row.memberId === memberId);
      if (!participant || participant.role === 'organizer') continue;
      if (participant.status !== 'pending' && participant.status !== 'confirmed') continue;
      try {
        await this.respond(detail.id, memberId, 'decline', actorId ?? memberId);
        released += 1;
      } catch (err) {
        // The reservation resolved (cancelled/expired) between list and
        // respond; nothing left to release.
        if (err instanceof InvalidReservationStatusError || err instanceof ReservationNotFoundError) {
          continue;
        }
        throw err;
      }
    }
    return { released };
  }

  /**
   * Crash/abandonment recovery for RESERVED refunds: rows still pending
   * with no stripeRefundId are money the member is owed that never reached
   * Stripe (crash between the reserving commit and refunds.create, or a
   * batch member whose Stripe call failed while others ran). Re-executes
   * each one under its stable per-row idempotency key; if the original
   * call actually went through, Stripe returns the SAME refund and
   * completeRefund converges instead of double-refunding.
   *
   * Called from the nightly reconcile AFTER its refund ingestion sweep, so
   * any refund that exists at Stripe was already adopted and stamped;
   * what is still unstamped genuinely never left. The age cutoff keeps a
   * phase-2 execution that is in flight right now out of scope.
   */
  async redriveStalePendingRefunds(now: Date = new Date()): Promise<{ reissued: number; failed: number }> {
    const cutoff = new Date(now.getTime() - STALE_REFUND_RETRY_MINUTES * 60_000);
    const rows = await this.reservationRepo.listStalePendingRefunds(cutoff);
    let reissued = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.executeReservedRefunds(
          row.reservationId,
          [{ paymentId: row.id, stripePaymentIntentId: row.stripePaymentIntentId, amountCents: row.amountCents }],
          undefined,
          'reconcile',
        );
        reissued += 1;
      } catch (error) {
        // The row is now marked failed with its balance restored (staff
        // alert seam); one bad refund must not abort the rest of the pass.
        failed += 1;
        console.error(`[bookings] re-drive of reserved refund ${row.id} failed:`, error);
      }
    }
    return { reissued, failed };
  }

  /**
   * A captured charge on a CANCELLED reservation (the pay-vs-drop TOCTOU).
   * Only charge rows still pending or marked failed can be orphaned:
   * cancel() settles captured holds through confirm-then-refund, marking
   * them succeeded, so succeeded rows were already in the cancellation's
   * math and the tier-kept balance stays untouched. The refund percent is
   * the one the cancellation actually applied (persisted as
   * cancelRefundPercent) for base charges, and 100% for an unapplied grow
   * delta (the extra time was never delivered). A Stripe capture is ground
   * truth: failed rows flip to succeeded too.
   */
  private async refundOrphanedCapture(
    detail: ReservationDetailRecord,
    options: { source?: string },
  ): Promise<'orphan_refunded' | 'already_settled' | 'not_captured'> {
    // Port calls stay OUTSIDE the transaction.
    const captured = new Map<string, 'pending' | 'failed'>();
    for (const payment of detail.payments) {
      if (payment.kind !== 'charge' || payment.status === 'succeeded' || !payment.stripePaymentIntentId) {
        continue;
      }
      if ((await this.paymentPort.getPaymentStatus(payment.stripePaymentIntentId)) === 'succeeded') {
        captured.set(payment.id, payment.status);
      }
    }
    if (captured.size === 0) return 'not_captured';

    const reserved = await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, detail.id);
      const fresh = await this.reservationRepo.getDetail(detail.id, tx);
      if (!fresh || fresh.status !== 'cancelled') return [] as ReservedRefund[];

      const percent = fresh.cancelRefundPercent ?? 100;
      let orphanedCents = 0;
      let refundCents = 0;
      let ledger = fresh.payments;
      for (const payment of fresh.payments) {
        const priorStatus = captured.get(payment.id);
        if (!priorStatus) continue;
        if (await this.reservationRepo.setPaymentStatusIf(tx, payment.id, priorStatus, 'succeeded')) {
          await this.reservationRepo.adjustAmountPaid(tx, detail.id, payment.amountCents);
          orphanedCents += payment.amountCents;
          refundCents +=
            payment.purpose === 'change_delta'
              ? payment.amountCents
              : computeRefundCents(payment.amountCents, percent);
          ledger = ledger.map((row) =>
            row.id === payment.id ? { ...row, status: 'succeeded' as const } : row,
          );
        }
      }
      if (orphanedCents === 0) return [] as ReservedRefund[]; // another path settled it

      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: detail.id,
        eventType: 'reservation.orphaned_capture_refunded',
        data: { capturedCents: orphanedCents, refundCents, refundPercent: percent },
        source: options.source,
      });
      if (refundCents === 0) return [] as ReservedRefund[]; // 0% tier keeps it all
      return this.reserveRefund(tx, detail.id, ledger, refundCents);
    });

    if (reserved.length === 0) return 'already_settled';
    await this.executeReservedRefunds(detail.id, reserved, undefined, options.source);
    return 'orphan_refunded';
  }

  /**
   * The CONFIRMED-reservation twin of refundOrphanedCapture: a captured
   * charge whose row is not succeeded and is not the live pendingChange's
   * charge belongs to a change that was superseded, dropped or swept while
   * its on-session intent captured (dropPendingChange decides on the DB row
   * alone; "pending never means uncaptured"). No live path ever settles it
   * — confirm() no-ops without a pending change — so the capture is
   * acknowledged (row -> succeeded, paid total up) and refunded IN FULL:
   * the changed time was never delivered. Refunds are capped at the
   * refundable balance so a dispute freeze withholds rather than throws.
   */
  private async refundOrphanedCaptureOnConfirmed(
    detail: ReservationDetailRecord,
    options: { source?: string },
  ): Promise<'orphan_refunded' | 'none'> {
    const liveChangeChargeId = detail.pendingChange?.chargePaymentId ?? null;
    const candidates = detail.payments.filter(
      (payment) =>
        payment.kind === 'charge' &&
        payment.status !== 'succeeded' &&
        payment.stripePaymentIntentId !== null &&
        payment.id !== liveChangeChargeId,
    );
    if (candidates.length === 0) return 'none'; // the hot path: zero extra port calls

    // Port calls stay OUTSIDE the transaction.
    const captured = new Map<string, 'pending' | 'failed'>();
    for (const payment of candidates) {
      if ((await this.paymentPort.getPaymentStatus(payment.stripePaymentIntentId!)) === 'succeeded') {
        captured.set(payment.id, payment.status as 'pending' | 'failed');
      }
    }
    if (captured.size === 0) return 'none';

    const reserved = await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, detail.id);
      const fresh = await this.reservationRepo.getDetail(detail.id, tx);
      if (!fresh || fresh.status !== 'confirmed') return [] as ReservedRefund[];

      let orphanedCents = 0;
      let ledger = fresh.payments;
      for (const payment of fresh.payments) {
        const priorStatus = captured.get(payment.id);
        if (!priorStatus) continue;
        // Re-parked meanwhile: a live change now owns this charge again.
        if (fresh.pendingChange?.chargePaymentId === payment.id) continue;
        if (await this.reservationRepo.setPaymentStatusIf(tx, payment.id, priorStatus, 'succeeded')) {
          await this.reservationRepo.adjustAmountPaid(tx, detail.id, payment.amountCents);
          orphanedCents += payment.amountCents;
          ledger = ledger.map((row) =>
            row.id === payment.id ? { ...row, status: 'succeeded' as const } : row,
          );
        }
      }
      if (orphanedCents === 0) return [] as ReservedRefund[]; // another path settled it

      const refundCents = Math.min(orphanedCents, computeRefundableCents(ledger));
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: detail.id,
        eventType: 'reservation.orphaned_capture_refunded',
        data: {
          capturedCents: orphanedCents,
          refundCents,
          refundPercent: 100,
          ...(refundCents < orphanedCents
            ? { withheldDisputedCents: orphanedCents - refundCents }
            : {}),
        },
        source: options.source,
      });
      if (refundCents === 0) return [] as ReservedRefund[];
      return this.reserveRefund(tx, detail.id, ledger, refundCents);
    });

    if (reserved.length === 0) return 'none';
    await this.executeReservedRefunds(detail.id, reserved, undefined, options.source);
    return 'orphan_refunded';
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

  /**
   * Confirmed reservations starting inside [from, to): the booking-reminder
   * cron's read (communications consumes it through a container-wired port).
   */
  async listConfirmedStartingBetween(from: Date, to: Date) {
    return this.reservationRepo.listConfirmedStartingBetween(from, to);
  }

  /**
   * Club-linked reservations (the club's group-activity feed). The CALLER
   * must have established club membership first; the clubs context gates
   * that at the route seam.
   */
  async listForClub(clubId: string, filter: 'upcoming' | 'past' | 'all' = 'upcoming') {
    return this.reservationRepo.listForClub(clubId, filter);
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
      now,
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
   * Reschedule. Two money paths, decided by the delta at the SNAPSHOT rate:
   *
   * - Shrink/equal: the claim-range UPDATE (self-excluding by construction
   *   of the exclusion constraint), guest reset and audit run in one
   *   transaction per candidate; the delta is recomputed from the FRESH
   *   in-transaction ledger under the per-reservation advisory lock and any
   *   refund is RESERVED in that same transaction (pending ledger rows that
   *   consume refundable balance), then executed at Stripe after commit.
   *   Two racing money paths therefore fail closed instead of both
   *   refunding the full balance.
   *
   * - Grow: nothing moves until the delta is captured. The delta
   *   PaymentIntent is created FIRST (a Stripe failure leaves the
   *   reservation untouched: no compensation to get wrong), the requested
   *   change is parked as a pending change with a TTL, and confirm() (or
   *   the webhook, or the sweeper for a died client) applies the move once
   *   the intent succeeds; an unpaid change lapses harmlessly. The member
   *   can never hold grown court time that was not paid for.
   */
  async reschedule(
    id: string,
    organizerId: string,
    change: { date: string; slots: string[] },
    actorId?: string,
    now: Date = new Date(),
  ): Promise<{ reservation: ReservationDetailRecord; deltaCents: number; clientSecret: string | null }> {
    const detail = await this.getOwn(id, organizerId);
    if (detail.status !== 'confirmed') {
      throw new InvalidReservationStatusError(detail.status, 'confirmed');
    }
    const actor = actorId ?? organizerId;

    // A parked grow whose delta ALREADY captured must be applied, never
    // dropped: settle it first, then reschedule on top of the fresh state.
    // (An unpaid one is superseded below and its intent voided through
    // voidOrRecoverIntent; a delta that captures inside the sub-second
    // pay-vs-drop window is acknowledged and refunded in full there, or by
    // the webhook/nightly reconcile driving the same
    // handleCapturedPayment orphan path.)
    if (detail.pendingChange) {
      const changeCharge = detail.payments.find(
        (payment) => payment.id === detail.pendingChange!.chargePaymentId,
      );
      if (changeCharge?.stripePaymentIntentId && changeCharge.status === 'pending') {
        const status = await this.paymentPort.getPaymentStatus(changeCharge.stripePaymentIntentId);
        if (status === 'succeeded') {
          try {
            await this.settlePendingChange(detail, { actorId: actor });
          } catch (error) {
            // Slot gone: the delta was refunded and the change cleared.
            if (!(error instanceof SlotUnavailableError)) throw error;
          }
          return this.reschedule(id, organizerId, change, actorId, now);
        }
      }
    }

    const type = detail.resourceType;
    const { startMinutes, durationMinutes } = parseSlotSelection(change.slots, this.gridConfig(type));
    this.assertWithinHorizon(type, change.date, now);
    const range = selectionToRange(change.date, startMinutes, this.gridConfig(type), this.timezone);
    if (range.startsAt <= now) throw new ReservationInPastError();

    // Reclaim dead holds first so a slot squatted by an abandoned hold is
    // actually reachable, then compute candidates.
    const resources = await this.resourceRepo.listActiveByType(type.id);
    await this.sweepExpiredHolds(resources.map((resource) => resource.id), now, 'reclaim');

    const { candidateIds } = await this.candidateResources(type, change.date, startMinutes, {
      excludeReservationId: id,
      now,
    });
    // Prefer keeping the same resource; a pure time shift then never moves courts.
    const ordered = [
      ...candidateIds.filter((candidate) => candidate === detail.resourceId),
      ...candidateIds.filter((candidate) => candidate !== detail.resourceId),
    ];
    if (ordered.length === 0) throw new SlotUnavailableError();

    const newTotalCents = computeTotalCents(detail.hourlyRateCentsSnapshot, durationMinutes);
    const previewDeltaCents = newTotalCents - computeNetPaidCents(detail.payments);

    if (previewDeltaCents > 0) {
      await this.assertUnderDailyLimit(undefined, type, organizerId, change.date, id);
      return this.requestGrowChange(detail, {
        range,
        localDate: change.date,
        newTotalCents,
        deltaCents: previewDeltaCents,
        preferredResourceId: ordered[0],
        actor,
        now,
      });
    }

    return this.applyImmediateReschedule(detail, type, {
      range,
      localDate: change.date,
      newTotalCents,
      ordered,
      actor,
      now,
    });
  }

  /** Shrink/equal reschedule: move now, settle any refund from fresh state. */
  private async applyImmediateReschedule(
    detail: ReservationDetailRecord,
    type: ResourceType,
    params: {
      range: { startsAt: Date; endsAt: Date };
      localDate: string;
      newTotalCents: number;
      ordered: string[];
      actor?: string;
      now: Date;
    },
  ): Promise<{ reservation: ReservationDetailRecord; deltaCents: number; clientSecret: string | null }> {
    const id = detail.id;
    let settled: { deltaCents: number; reserved: ReservedRefund[]; replacedIntentId: string | null } | null = null;

    for (const resourceId of params.ordered) {
      try {
        settled = await this.uow.execute(async (tx) => {
          await this.reservationRepo.advisoryLockMember(tx, detail.organizerId);
          await this.reservationRepo.advisoryLockReservation(tx, id);
          const fresh = await this.reservationRepo.getDetail(id, tx);
          if (!fresh || fresh.status !== 'confirmed') {
            throw new InvalidReservationStatusError(fresh?.status ?? 'missing', 'confirmed');
          }
          await this.assertUnderDailyLimit(tx, type, detail.organizerId, params.localDate, id);
          await this.releaseExpiredHoldsWithAudit(tx, [resourceId], params.now);

          // A shrink supersedes any unpaid grow request still parked.
          const replacedIntentId = await this.dropPendingChange(tx, fresh);
          const ledger = replacedIntentId !== null
            ? fresh.payments.map((payment) =>
                payment.id === fresh.pendingChange?.chargePaymentId
                  ? { ...payment, status: 'failed' as const }
                  : payment,
              )
            : fresh.payments;

          // Money from FRESH in-transaction state, under the lock; the
          // pre-transaction preview only chose the path.
          const deltaCents = params.newTotalCents - computeNetPaidCents(ledger);
          if (deltaCents > 0) throw new ReservationChangedError();

          await this.reservationRepo.moveClaimAndReservation(tx, {
            reservationId: id,
            resourceId,
            startsAt: params.range.startsAt,
            endsAt: params.range.endsAt,
            localDate: params.localDate,
          });
          const resetMemberIds = await this.reservationRepo.resetConfirmedGuestsToPending(tx, id);
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: id,
            eventType: 'reservation.rescheduled',
            data: {
              from: { startsAt: fresh.startsAt.toISOString(), endsAt: fresh.endsAt.toISOString(), resourceId: fresh.resourceId },
              to: { startsAt: params.range.startsAt.toISOString(), endsAt: params.range.endsAt.toISOString(), resourceId },
              deltaCents,
              resetParticipants: resetMemberIds,
            },
            actorId: params.actor,
          });

          const reserved = deltaCents < 0 ? await this.reserveRefund(tx, id, ledger, -deltaCents) : [];
          return { deltaCents, reserved, replacedIntentId };
        });
        break;
      } catch (error) {
        if (error instanceof SlotUnavailableError) continue;
        throw error;
      }
    }

    if (!settled) throw new SlotUnavailableError();

    if (settled.replacedIntentId) {
      await this.voidOrRecoverIntent(id, settled.replacedIntentId, 'reschedule');
    }
    await this.executeReservedRefunds(id, settled.reserved, params.actor);

    return {
      reservation: (await this.reservationRepo.getDetail(id))!,
      deltaCents: settled.deltaCents,
      clientSecret: null,
    };
  }

  /** Grow: park the change; the move applies only once the delta is paid. */
  private async requestGrowChange(
    detail: ReservationDetailRecord,
    params: {
      range: { startsAt: Date; endsAt: Date };
      localDate: string;
      newTotalCents: number;
      deltaCents: number;
      preferredResourceId: string;
      actor?: string;
      now: Date;
    },
  ): Promise<{ reservation: ReservationDetailRecord; deltaCents: number; clientSecret: string | null }> {
    const id = detail.id;

    // The intent exists BEFORE anything is written: a Stripe failure leaves
    // the reservation exactly as it was (create() needs compensation because
    // it must hold the slot first; a grow already owns its slot).
    const intent = await this.paymentPort.createPaymentIntent({
      reservationId: id,
      memberId: detail.organizerId,
      amountCents: params.deltaCents,
      attempt: detail.payments.length + 1,
    });

    const expiresAt = new Date(params.now.getTime() + this.holdMinutes * 60_000);
    let staleQuote = false;
    let replacedIntentId: string | null = null;

    await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, id);
      const fresh = await this.reservationRepo.getDetail(id, tx);
      if (!fresh || fresh.status !== 'confirmed') {
        throw new InvalidReservationStatusError(fresh?.status ?? 'missing', 'confirmed');
      }

      replacedIntentId = await this.dropPendingChange(tx, fresh);
      const ledger = replacedIntentId !== null
        ? fresh.payments.map((payment) =>
            payment.id === fresh.pendingChange?.chargePaymentId
              ? { ...payment, status: 'failed' as const }
              : payment,
          )
        : fresh.payments;

      const freshDeltaCents = params.newTotalCents - computeNetPaidCents(ledger);
      if (freshDeltaCents !== params.deltaCents) {
        staleQuote = true;
        return;
      }

      const chargeRow = await this.reservationRepo.addPayment(tx, {
        reservationId: id,
        kind: 'charge',
        purpose: 'change_delta',
        amountCents: params.deltaCents,
        stripePaymentIntentId: intent.paymentIntentId,
        status: 'pending',
      });
      await this.reservationRepo.createPendingChange(tx, {
        reservationId: id,
        resourceId: params.preferredResourceId,
        startsAt: params.range.startsAt,
        endsAt: params.range.endsAt,
        localDate: params.localDate,
        deltaCents: params.deltaCents,
        chargePaymentId: chargeRow.id,
        expiresAt,
      });
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.change_requested',
        data: {
          to: { startsAt: params.range.startsAt.toISOString(), endsAt: params.range.endsAt.toISOString() },
          deltaCents: params.deltaCents,
          expiresAt: expiresAt.toISOString(),
        },
        actorId: params.actor,
      });
    });

    if (replacedIntentId) {
      await this.voidOrRecoverIntent(id, replacedIntentId, 'reschedule');
    }
    if (staleQuote) {
      // The new intent has no charge row and its secret never reached the
      // client, so a plain void suffices; reconcile owns any residual.
      await this.paymentPort.cancelPaymentIntent(intent.paymentIntentId).catch(() => {});
      throw new ReservationChangedError();
    }

    return {
      reservation: (await this.reservationRepo.getDetail(id))!,
      deltaCents: params.deltaCents,
      clientSecret: intent.clientSecret,
    };
  }

  /**
   * Applies a PAID pending change: re-validates candidates for the parked
   * range, moves the claim (exclusion constraint arbitrating), resets
   * confirmed guests and captures the delta into the ledger. When the slot
   * was taken while the member paid, the delta is refunded in full and the
   * original booking stays untouched.
   */
  private async settlePendingChange(
    detail: ReservationDetailRecord,
    options: { actorId?: string; source?: string },
  ): Promise<ReservationDetailRecord> {
    const id = detail.id;
    const pending = detail.pendingChange!;
    const charge = detail.payments.find((payment) => payment.id === pending.chargePaymentId);
    if (!charge?.stripePaymentIntentId) throw new PaymentNotCompletedError();
    const paymentStatus = await this.paymentPort.getPaymentStatus(charge.stripePaymentIntentId);
    if (paymentStatus !== 'succeeded') throw new PaymentNotCompletedError();

    const now = new Date();
    const type = detail.resourceType;
    const config = this.gridConfig(type);
    const startMin = zonedMinutesSinceMidnight(pending.startsAt, this.timezone, pending.localDate);
    const endMin = zonedMinutesSinceMidnight(pending.endsAt, this.timezone, pending.localDate);
    const startMinutes: number[] = [];
    for (let minute = startMin; minute < endMin; minute += config.slotDurationMinutes) {
      startMinutes.push(minute);
    }

    const { candidateIds } = await this.candidateResources(type, pending.localDate, startMinutes, {
      excludeReservationId: id,
      now,
    });
    const ordered = [...new Set([pending.resourceId, detail.resourceId, ...candidateIds])].filter(
      (candidate) => candidateIds.includes(candidate),
    );

    for (const resourceId of ordered) {
      try {
        const outcome = await this.uow.execute(async (tx) => {
          await this.reservationRepo.advisoryLockMember(tx, detail.organizerId);
          await this.reservationRepo.advisoryLockReservation(tx, id);
          const fresh = await this.reservationRepo.getDetail(id, tx);
          if (!fresh || fresh.status !== 'confirmed' || fresh.pendingChange?.id !== pending.id) {
            return 'stale' as const;
          }
          // The change may land on a different local date; re-check the limit.
          await this.assertUnderDailyLimit(tx, type, detail.organizerId, pending.localDate, id);
          await this.releaseExpiredHoldsWithAudit(tx, [resourceId], now);

          await this.reservationRepo.moveClaimAndReservation(tx, {
            reservationId: id,
            resourceId,
            startsAt: pending.startsAt,
            endsAt: pending.endsAt,
            localDate: pending.localDate,
          });
          const resetMemberIds = await this.reservationRepo.resetConfirmedGuestsToPending(tx, id);
          await this.reservationRepo.clearPendingChange(tx, id);
          if (await this.reservationRepo.setPaymentStatusIf(tx, charge.id, 'pending', 'succeeded')) {
            await this.reservationRepo.adjustAmountPaid(tx, id, charge.amountCents);
            await this.audit.append(tx, {
              streamType: STREAM_TYPE,
              streamId: id,
              eventType: 'reservation.payment_captured',
              data: { amountCents: charge.amountCents, stripePaymentIntentId: charge.stripePaymentIntentId },
              actorId: options.actorId,
              source: options.source,
            });
          }
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: id,
            eventType: 'reservation.rescheduled',
            data: {
              from: { startsAt: fresh.startsAt.toISOString(), endsAt: fresh.endsAt.toISOString(), resourceId: fresh.resourceId },
              to: { startsAt: pending.startsAt.toISOString(), endsAt: pending.endsAt.toISOString(), resourceId },
              deltaCents: pending.deltaCents,
              resetParticipants: resetMemberIds,
            },
            actorId: options.actorId,
            source: options.source,
          });
          return 'applied' as const;
        });

        if (outcome === 'stale') {
          // Another path resolved the change (applied it, cancelled the
          // reservation, or swept it). Idempotent success when the
          // reservation is fine; otherwise report its actual state.
          const fresh = await this.reservationRepo.getDetail(id);
          if (fresh && fresh.status === 'confirmed' && !fresh.pendingChange) return fresh;
          throw new InvalidReservationStatusError(fresh?.status ?? 'missing', 'confirmed');
        }
        return (await this.reservationRepo.getDetail(id))!;
      } catch (error) {
        if (error instanceof SlotUnavailableError) continue;
        throw error;
      }
    }

    // Slot gone: the member keeps the original booking and the captured
    // delta comes straight back.
    const reserved = await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, id);
      const fresh = await this.reservationRepo.getDetail(id, tx);
      if (!fresh || fresh.pendingChange?.id !== pending.id) return [] as ReservedRefund[];
      await this.reservationRepo.clearPendingChange(tx, id);
      let ledger = fresh.payments;
      if (await this.reservationRepo.setPaymentStatusIf(tx, charge.id, 'pending', 'succeeded')) {
        await this.reservationRepo.adjustAmountPaid(tx, id, charge.amountCents);
        ledger = ledger.map((payment) =>
          payment.id === charge.id ? { ...payment, status: 'succeeded' as const } : payment,
        );
      }
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.change_rejected',
        data: { reason: 'slot_unavailable', deltaCents: pending.deltaCents },
        actorId: options.actorId,
        source: options.source,
      });
      return this.reserveRefund(tx, id, ledger, charge.amountCents);
    });
    await this.executeReservedRefunds(id, reserved, options.actorId, options.source);
    throw new SlotUnavailableError();
  }

  // ── Cancel ──

  /**
   * Cancel with the tiered refund policy (100% >24h, 50% 2-24h, 0% inside).
   * Admin and event-conflict cancellations refund in full: the club
   * cancelled, not the member.
   *
   * pending_payment does NOT mean uncaptured: the on-session intent may have
   * succeeded moments before (confirm/webhook lag), so the intent status is
   * checked first, exactly like the sweeper, and a paid hold is confirmed
   * before cancelling so the tiered refund sees the money. Refund percent
   * and balance are computed from FRESH in-transaction state under the
   * per-reservation advisory lock, and the refund is RESERVED in the same
   * transaction (fail-closed against any concurrent money path) before
   * Stripe runs.
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

    // Payment-status reads happen OUTSIDE the transaction (port calls).
    let holdIntentToVoid: string | null = null;
    if (detail.status === 'pending_payment') {
      const charge = [...detail.payments].reverse().find((payment) => payment.kind === 'charge');
      const paymentStatus = charge?.stripePaymentIntentId
        ? await this.paymentPort.getPaymentStatus(charge.stripePaymentIntentId)
        : 'failed';
      if (paymentStatus === 'succeeded' && charge) {
        // Captured money: settle as confirmed first so the refund path owns it.
        await this.settlePendingConfirmation(id, charge, { actorId: actor });
      } else {
        holdIntentToVoid = charge?.stripePaymentIntentId ?? null;
      }
    }

    // An unapplied pending change refunds its captured delta IN FULL (the
    // extra time was never delivered, so no tier applies); an unpaid one is
    // simply dropped and its intent voided.
    let pendingChangePaid = false;
    if (detail.pendingChange) {
      const changeCharge = detail.payments.find(
        (payment) => payment.id === detail.pendingChange!.chargePaymentId,
      );
      if (changeCharge?.stripePaymentIntentId && changeCharge.status === 'pending') {
        pendingChangePaid =
          (await this.paymentPort.getPaymentStatus(changeCharge.stripePaymentIntentId)) === 'succeeded';
      }
    }

    const settlement = await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, id);
      const fresh = await this.reservationRepo.getDetail(id, tx);
      if (!fresh || !isActiveReservationStatus(fresh.status)) {
        throw new InvalidReservationStatusError(fresh?.status ?? 'missing', 'pending_payment or confirmed');
      }
      const cancelled = await this.reservationRepo.transitionStatus(
        tx,
        id,
        ['pending_payment', 'confirmed'],
        'cancelled',
      );
      if (!cancelled) {
        throw new InvalidReservationStatusError(fresh.status, 'pending_payment or confirmed');
      }
      await this.reservationRepo.releaseClaim(tx, id);

      // Resolve any parked change request.
      let ledger = fresh.payments;
      let changeIntentToVoid: string | null = null;
      let paidChangeCents = 0;
      if (fresh.pendingChange) {
        const changeCharge = fresh.payments.find(
          (payment) => payment.id === fresh.pendingChange!.chargePaymentId,
        );
        await this.reservationRepo.clearPendingChange(tx, id);
        if (changeCharge?.status === 'pending') {
          if (pendingChangePaid) {
            if (await this.reservationRepo.setPaymentStatusIf(tx, changeCharge.id, 'pending', 'succeeded')) {
              await this.reservationRepo.adjustAmountPaid(tx, id, changeCharge.amountCents);
              ledger = ledger.map((payment) =>
                payment.id === changeCharge.id ? { ...payment, status: 'succeeded' as const } : payment,
              );
              paidChangeCents = changeCharge.amountCents;
            }
          } else {
            await this.reservationRepo.setPaymentStatusIf(tx, changeCharge.id, 'pending', 'failed');
            changeIntentToVoid = changeCharge.stripePaymentIntentId;
            ledger = ledger.map((payment) =>
              payment.id === changeCharge.id ? { ...payment, status: 'failed' as const } : payment,
            );
          }
        }
      }

      const netPaidCents = computeNetPaidCents(ledger);
      const percent = options.fullRefund ? 100 : refundPercentFor(fresh.startsAt, now);
      const policyRefundCents = computeRefundCents(netPaidCents - paidChangeCents, percent) + paidChangeCents;
      // A disputed charge is frozen: refund only what is actually
      // refundable, audit the withheld remainder, and never fail the
      // cancellation itself (the member must always be able to free the
      // slot; staff resolve the dispute).
      const refundableCents = computeRefundableCents(ledger);
      const refundCents = Math.min(policyRefundCents, refundableCents);

      // Persisted so a charge that captures AFTER this cancel (pay-vs-drop
      // TOCTOU) refunds at the same percent instead of 100%.
      await this.reservationRepo.setCancelRefundPercent(tx, id, percent);

      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.cancelled',
        data: {
          refundCents,
          refundPercent: percent,
          previousStatus: fresh.status,
          ...(refundCents < policyRefundCents
            ? { withheldDisputedCents: policyRefundCents - refundCents }
            : {}),
        },
        actorId: actor,
      });
      const reserved = refundCents > 0 ? await this.reserveRefund(tx, id, ledger, refundCents) : [];
      return { refundCents, reserved, previousStatus: fresh.status, changeIntentToVoid };
    });

    // Void the unpaid intents outside the transaction. A void that fails
    // because the intent captured mid-cancel routes straight back through
    // the orphaned-capture refund; webhook + reconcile cover any residual.
    if (settlement.previousStatus === 'pending_payment' && holdIntentToVoid) {
      await this.voidOrRecoverIntent(id, holdIntentToVoid, 'cancel');
    }
    if (settlement.changeIntentToVoid) {
      await this.voidOrRecoverIntent(id, settlement.changeIntentToVoid, 'cancel');
    }
    await this.executeReservedRefunds(id, settlement.reserved, actor);
    return { refundCents: settlement.refundCents };
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

  /**
   * Invite permission: organizer + confirmed participants (decision 6).
   * Club chips expand to the club's current member set with viaClubId
   * provenance; the acting inviter must belong to every named club (they
   * are sharing THEIR club), and a directly-named member outranks their
   * club expansion.
   */
  async addParticipants(
    id: string,
    viewerMemberId: string,
    invitees: { memberIds?: string[]; clubIds?: string[] },
    actorId?: string,
  ): Promise<{ invited: string[] }> {
    const requested = [...new Set(invitees.memberIds ?? [])];
    const existing = await this.reservationRepo.filterExistingMemberIds(requested);
    const missing = requested.filter((memberId) => !existing.has(memberId));
    if (missing.length > 0) throw new InviteeNotFoundError(missing);

    // Snapshot expansion outside the transaction, like create().
    const clubInvitees = await this.expandClubInvitees(invitees.clubIds ?? [], viewerMemberId);
    for (const memberId of requested) clubInvitees.delete(memberId);

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
      const inviteOne = async (memberId: string, viaClubId: string | null) => {
        if (memberId === detail.organizerId) return;
        const current = detail.participants.find((row) => row.memberId === memberId);
        // "Add all" hitting an already-invited member is a no-op, not a dup.
        if (current && (current.status === 'pending' || current.status === 'confirmed')) return;

        await this.reservationRepo.upsertPendingInvite(tx, {
          reservationId: id,
          memberId,
          invitedById: viewerMemberId,
          viaClubId,
        });
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: id,
          eventType: 'reservation.participant_invited',
          data: {
            memberId,
            invitedById: viewerMemberId,
            reinvite: Boolean(current),
            ...(viaClubId ? { viaClubId } : {}),
          },
          actorId: actorId ?? viewerMemberId,
        });
        invited.push(memberId);
      };

      for (const memberId of requested) await inviteOne(memberId, null);
      for (const [memberId, viaClubId] of clubInvitees) await inviteOne(memberId, viaClubId);

      return { invited };
    });
  }

  /**
   * Club chips -> member ids (memberId -> viaClubId; the first club listing
   * a member carries the provenance). The roster port rejects any club the
   * inviter does not belong to; without a wired port (package D absent) the
   * path fails closed the same way.
   */
  private async expandClubInvitees(
    clubIds: string[],
    inviterId: string,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(clubIds)];
    if (unique.length === 0) return new Map();
    if (!this.clubRoster) throw new ClubInviteNotAllowedError();

    const rosters = await this.clubRoster.getRostersForInviter(unique, inviterId);
    const expansion = new Map<string, string>();
    for (const roster of rosters) {
      for (const memberId of roster.memberIds) {
        if (memberId === inviterId) continue;
        if (!expansion.has(memberId)) expansion.set(memberId, roster.clubId);
      }
    }
    return expansion;
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
   * Expire stale pending_payment holds and lapsed pending changes, checking
   * the PaymentIntent first in both cases: paid money is always settled
   * (confirm the hold / apply the change), never dropped.
   */
  async expireStaleHolds(
    now: Date = new Date(),
  ): Promise<{ expired: number; confirmed: number; changesApplied: number; changesExpired: number }> {
    const holds = await this.sweepExpiredHolds(undefined, now, 'sweeper');
    const changes = await this.sweepExpiredPendingChanges(now);
    return { ...holds, ...changes };
  }

  /**
   * Shared payment-aware sweep, used by the cron sweeper (all resources) and
   * by create/reschedule to reclaim dead holds on the resources they are
   * about to book. A hold whose intent succeeded is confirmed (the CAS +
   * per-reservation lock make client/webhook/sweeper races settle on exactly
   * one winner); anything else is expired and released.
   */
  private async sweepExpiredHolds(
    resourceIds: string[] | undefined,
    now: Date,
    source: string,
  ): Promise<{ expired: number; confirmed: number }> {
    if (resourceIds && resourceIds.length === 0) return { expired: 0, confirmed: 0 };
    const holds = await this.reservationRepo.listExpiredHolds(now, resourceIds);
    let expired = 0;
    let confirmed = 0;

    for (const hold of holds) {
      const charge = [...hold.payments].reverse().find((payment) => payment.kind === 'charge');
      const paymentStatus = charge?.stripePaymentIntentId
        ? await this.paymentPort.getPaymentStatus(charge.stripePaymentIntentId)
        : 'failed';

      if (paymentStatus === 'succeeded' && charge) {
        const outcome = await this.settlePendingConfirmation(hold.id, charge, { source });
        if (outcome === 'confirmed') confirmed += 1;
        continue;
      }

      const didExpire = await this.uow.execute(async (tx) => {
        await this.reservationRepo.advisoryLockReservation(tx, hold.id);
        const transitioned = await this.reservationRepo.transitionStatus(
          tx,
          hold.id,
          ['pending_payment'],
          'expired',
        );
        if (!transitioned) return false; // confirmed or cancelled mid-race
        await this.reservationRepo.releaseClaim(tx, hold.id);
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: hold.id,
          eventType: 'reservation.expired',
          data: { reason: 'hold_ttl' },
          source,
        });
        return true;
      });
      if (!didExpire) continue;
      if (charge?.stripePaymentIntentId) {
        await this.voidOrRecoverIntent(hold.id, charge.stripePaymentIntentId, source);
      }
      expired += 1;
    }

    return { expired, confirmed };
  }

  /** Lapsed pending changes: apply the paid ones, drop the unpaid ones. */
  private async sweepExpiredPendingChanges(
    now: Date,
  ): Promise<{ changesApplied: number; changesExpired: number }> {
    const stale = await this.reservationRepo.listExpiredPendingChanges(now);
    let changesApplied = 0;
    let changesExpired = 0;

    for (const detail of stale) {
      const pending = detail.pendingChange!;
      const charge = detail.payments.find((payment) => payment.id === pending.chargePaymentId);
      const paymentStatus = charge?.stripePaymentIntentId
        ? await this.paymentPort.getPaymentStatus(charge.stripePaymentIntentId)
        : 'failed';

      if (paymentStatus === 'succeeded' && charge) {
        // A died client must not lose a paid grow: apply it (or refund the
        // delta inside settlePendingChange when the slot is gone).
        try {
          await this.settlePendingChange(detail, { source: 'sweeper' });
          changesApplied += 1;
        } catch (error) {
          if (error instanceof SlotUnavailableError) {
            changesExpired += 1; // delta refunded, original booking intact
          } else if (!(error instanceof InvalidReservationStatusError)) {
            throw error;
          }
        }
        continue;
      }

      const cleared = await this.uow.execute(async (tx) => {
        await this.reservationRepo.advisoryLockReservation(tx, detail.id);
        const fresh = await this.reservationRepo.getDetail(detail.id, tx);
        if (!fresh || fresh.pendingChange?.id !== pending.id) return false;
        await this.reservationRepo.clearPendingChange(tx, detail.id);
        if (charge) {
          await this.reservationRepo.setPaymentStatusIf(tx, charge.id, 'pending', 'failed');
        }
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: detail.id,
          eventType: 'reservation.change_expired',
          data: { deltaCents: pending.deltaCents },
          source: 'sweeper',
        });
        return true;
      });
      if (!cleared) continue;
      if (charge?.stripePaymentIntentId) {
        await this.voidOrRecoverIntent(detail.id, charge.stripePaymentIntentId, 'sweeper');
      }
      changesExpired += 1;
    }

    return { changesApplied, changesExpired };
  }

  // ── Internals ──

  /**
   * The one place a pending_payment hold becomes confirmed. Compare-and-set
   * under the per-reservation advisory lock: exactly one of a racing client
   * confirm, webhook and sweeper wins and appends the payment_captured +
   * confirmed audit events; the others see 'already_confirmed' or 'lost'
   * and write nothing (no duplicate outbox rows, no clobbered cancel).
   */
  private async settlePendingConfirmation(
    id: string,
    charge: ReservationPayment,
    options: { actorId?: string; source?: string },
  ): Promise<ConfirmOutcome> {
    return this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, id);
      const fresh = await this.reservationRepo.getDetail(id, tx);
      if (!fresh) return 'lost';
      if (fresh.status === 'confirmed') return 'already_confirmed';
      if (fresh.status !== 'pending_payment') return 'lost';

      const paidLedger = fresh.payments.map((payment) =>
        payment.id === charge.id ? { ...payment, status: 'succeeded' as const } : payment,
      );
      const confirmed = await this.reservationRepo.confirmFrom(
        tx,
        id,
        'pending_payment',
        computeNetPaidCents(paidLedger),
      );
      if (!confirmed) return 'lost';
      await this.reservationRepo.setPaymentStatusIf(tx, charge.id, 'pending', 'succeeded');
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.payment_captured',
        data: { amountCents: charge.amountCents, stripePaymentIntentId: charge.stripePaymentIntentId },
        actorId: options.actorId,
        source: options.source,
      });
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.confirmed',
        data: { reference: fresh.reference, ...(options.source ? { via: options.source } : {}) },
        actorId: options.actorId,
        source: options.source,
      });
      return 'confirmed';
    });
  }

  /**
   * An expired reservation whose intent actually captured (client died,
   * webhook lag, or a force-released hold that raced its payment) must never
   * strand the money: re-acquire the slot if it is still free and confirm;
   * otherwise refund the captured charge in full. The package-C
   * payment_intent.succeeded webhook lands here for exactly this case.
   */
  private async recoverExpiredIfPaid(
    detail: ReservationDetailRecord,
    options: { actorId?: string; source?: string },
  ): Promise<ReservationDetailRecord> {
    const id = detail.id;
    const charge = [...detail.payments].reverse().find((payment) => payment.kind === 'charge');
    if (!charge?.stripePaymentIntentId) throw new HoldExpiredError();
    const paymentStatus = await this.paymentPort.getPaymentStatus(charge.stripePaymentIntentId);
    if (paymentStatus !== 'succeeded') throw new HoldExpiredError();

    let reacquired = false;
    try {
      reacquired = await this.uow.execute(async (tx) => {
        await this.reservationRepo.advisoryLockReservation(tx, id);
        const fresh = await this.reservationRepo.getDetail(id, tx);
        if (!fresh) return false;
        if (fresh.status === 'confirmed') return true; // another recoverer won
        if (fresh.status !== 'expired') return false;

        // The exclusion constraint arbitrates the re-acquisition.
        if (!(await this.reservationRepo.reactivateClaim(tx, id))) return false;
        const paidLedger = fresh.payments.map((payment) =>
          payment.id === charge.id ? { ...payment, status: 'succeeded' as const } : payment,
        );
        if (!(await this.reservationRepo.confirmFrom(tx, id, 'expired', computeNetPaidCents(paidLedger)))) {
          return false;
        }
        await this.reservationRepo.setPaymentStatusIf(tx, charge.id, 'pending', 'succeeded');
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: id,
          eventType: 'reservation.payment_captured',
          data: { amountCents: charge.amountCents, stripePaymentIntentId: charge.stripePaymentIntentId },
          actorId: options.actorId,
          source: options.source,
        });
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: id,
          eventType: 'reservation.confirmed',
          data: { reference: fresh.reference, recovered: true },
          actorId: options.actorId,
          source: options.source,
        });
        return true;
      });
    } catch (error) {
      if (!(error instanceof SlotUnavailableError)) throw error;
      reacquired = false;
    }

    if (reacquired) return (await this.reservationRepo.getDetail(id))!;

    // Slot gone: make the member whole instead of stranding the charge.
    const reserved = await this.uow.execute(async (tx) => {
      await this.reservationRepo.advisoryLockReservation(tx, id);
      const fresh = await this.reservationRepo.getDetail(id, tx);
      if (!fresh || fresh.status !== 'expired') return [] as ReservedRefund[];
      let ledger = fresh.payments;
      if (await this.reservationRepo.setPaymentStatusIf(tx, charge.id, 'pending', 'succeeded')) {
        ledger = ledger.map((payment) =>
          payment.id === charge.id ? { ...payment, status: 'succeeded' as const } : payment,
        );
      }
      // Refundable balance, not net paid: a disputed charge stays frozen.
      const refundable = computeRefundableCents(ledger);
      if (refundable <= 0) return [] as ReservedRefund[]; // already refunded: idempotent
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: id,
        eventType: 'reservation.expired_paid_refunded',
        data: { amountCents: refundable, stripePaymentIntentId: charge.stripePaymentIntentId },
        actorId: options.actorId,
        source: options.source,
      });
      return this.reserveRefund(tx, id, ledger, refundable);
    });
    await this.executeReservedRefunds(id, reserved, options.actorId, options.source);
    throw new HoldExpiredError();
  }

  /**
   * Phase 1 of a refund, inside the caller's transaction (which holds the
   * per-reservation advisory lock): allocate against the FRESH ledger and
   * write PENDING refund rows. Pending refunds consume refundable balance
   * (see allocateRefund), so a concurrent money path re-reading the ledger
   * fails closed instead of refunding the same charge twice. Stripe runs
   * after commit in phase 2 (executeReservedRefunds).
   */
  private async reserveRefund(
    tx: TransactionContext,
    reservationId: string,
    payments: Array<Pick<ReservationPayment, 'id' | 'kind' | 'amountCents' | 'status' | 'stripePaymentIntentId' | 'createdAt'>>,
    refundCents: number,
  ): Promise<ReservedRefund[]> {
    const allocations = allocateRefund(payments, refundCents); // throws fail-closed
    const reserved: ReservedRefund[] = [];
    for (const allocation of allocations) {
      const row = await this.reservationRepo.addPayment(tx, {
        reservationId,
        kind: 'refund',
        amountCents: allocation.amountCents,
        stripePaymentIntentId: allocation.stripePaymentIntentId,
        status: 'pending',
      });
      reserved.push({ paymentId: row.id, ...allocation });
    }
    if (allocations.length > 0) {
      await this.reservationRepo.adjustAmountPaid(tx, reservationId, -refundCents);
    }
    return reserved;
  }

  /**
   * Phase 2: execute reserved refunds at Stripe, then mark each row
   * succeeded. Every allocation is ATTEMPTED even when an earlier one
   * fails: the allocations are independent Stripe calls, and aborting the
   * batch would strand the untouched rows as pending-with-decremented-
   * balance owed to the member with nothing in flight. A failed allocation
   * is marked failed with its amount restored (staff alert seam,
   * TODO(package-f)); the first error is rethrown after the batch so a
   * webhook caller still 500s and retries. Rows a crash leaves pending are
   * re-driven by the nightly reconcile (redriveStalePendingRefunds) under
   * the same per-row idempotency keys.
   */
  private async executeReservedRefunds(
    reservationId: string,
    reserved: ReservedRefund[],
    actorId?: string,
    source?: string,
  ): Promise<void> {
    let firstError: unknown = null;
    for (const refund of reserved) {
      let refundId: string;
      try {
        ({ refundId } = await this.paymentPort.refund({
          paymentIntentId: refund.stripePaymentIntentId,
          amountCents: refund.amountCents,
          reservationId,
          // The reserved row id: a stable idempotency key per refund, so a
          // crash-retry can never double-refund and two legitimate
          // same-amount refunds can never collide.
          refundKey: refund.paymentId,
        }));
      } catch (error) {
        await this.uow.execute(async (tx) => {
          await this.reservationRepo.advisoryLockReservation(tx, reservationId);
          if (await this.reservationRepo.setPaymentStatusIf(tx, refund.paymentId, 'pending', 'failed')) {
            await this.reservationRepo.adjustAmountPaid(tx, reservationId, refund.amountCents);
          }
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: reservationId,
            eventType: 'reservation.refund_failed',
            data: { amountCents: refund.amountCents, stripePaymentIntentId: refund.stripePaymentIntentId },
            actorId,
            source,
          });
        });
        firstError ??= error;
        continue;
      }
      await this.uow.execute(async (tx) => {
        await this.reservationRepo.completeRefund(tx, refund.paymentId, refundId);
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: reservationId,
          eventType: 'reservation.payment_refunded',
          data: { amountCents: refund.amountCents, stripeRefundId: refundId },
          actorId,
          source,
        });
      });
    }
    if (firstError) throw firstError;
  }

  /**
   * Best-effort void of a superseded or abandoned intent, with the
   * pay-vs-drop TOCTOU closed: Stripe refuses to cancel a captured intent,
   * and "pending never means uncaptured", so a cancel failure is routed
   * straight back through handleCapturedPayment, which settles or refunds
   * the capture (orphan paths for cancelled, expired AND confirmed
   * reservations). A transient miss here converges anyway: the
   * payment_intent.succeeded webhook and the nightly reconcile drive the
   * same entry point.
   */
  private async voidOrRecoverIntent(
    reservationId: string,
    intentId: string,
    source?: string,
  ): Promise<void> {
    try {
      await this.paymentPort.cancelPaymentIntent(intentId);
      return;
    } catch {
      // Possibly captured; fall through to the settlement entry point.
    }
    try {
      const row = await this.reservationRepo.findChargeByPaymentIntent(undefined, reservationId, intentId);
      if (!row) return;
      await this.handleCapturedPayment(reservationId, {
        source: source ?? 'void_recovery',
        intent: { paymentIntentId: intentId, amountCents: row.amountCents },
      });
    } catch {
      // Webhook + nightly reconcile converge on the same entry point.
    }
  }

  /**
   * Drops a parked pending change inside the caller's transaction, marking
   * its unpaid charge failed. Returns the intent id to void post-commit, or
   * null when there was nothing to drop. The DB row alone cannot prove the
   * intent is uncaptured, so the post-commit void MUST go through
   * voidOrRecoverIntent (a captured delta is then acknowledged and
   * refunded instead of stranded).
   */
  private async dropPendingChange(
    tx: TransactionContext,
    fresh: ReservationDetailRecord,
  ): Promise<string | null> {
    if (!fresh.pendingChange) return null;
    const changeCharge = fresh.payments.find(
      (payment) => payment.id === fresh.pendingChange!.chargePaymentId,
    );
    await this.reservationRepo.clearPendingChange(tx, fresh.id);
    if (changeCharge?.status === 'pending') {
      await this.reservationRepo.setPaymentStatusIf(tx, changeCharge.id, 'pending', 'failed');
      return changeCharge.stripePaymentIntentId ?? null;
    }
    return null;
  }

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
   * displayOrder so the retry loop walks a stable candidate list. Passing
   * `now` makes expired-but-unswept holds read as free (the write paths
   * reclaim them before inserting).
   */
  private async candidateResources(
    type: ResourceType,
    dateKey: string,
    startMinutes: number[],
    options: { excludeReservationId?: string; now?: Date } = {},
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
}
