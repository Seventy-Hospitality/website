import { createId } from '@paralleldrive/cuid2';
import type { PrismaClient } from '@prisma/client';
import type { TransactionContext } from '@/lib/kernel';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type {
  ParticipantRole,
  ParticipantStatus,
  Reservation,
  ReservationParticipant,
  ReservationPayment,
  ReservationPendingChange,
  ReservationStatus,
  ResourceType,
} from '../domain';
import { SlotUnavailableError } from '../domain';
import { isClaimConflictError } from './pg-errors';

export interface ParticipantWithMember extends ReservationParticipant {
  member: { id: string; firstName: string; lastName: string; email: string };
}

export interface ReservationDetailRecord extends Reservation {
  resourceType: ResourceType;
  resource: { id: string; name: string };
  participants: ParticipantWithMember[];
  payments: ReservationPayment[];
  claim: { id: string; status: string; expiresAt: Date | null } | null;
  pendingChange: ReservationPendingChange | null;
}

export interface CreateReservationInput {
  resourceTypeId: string;
  resourceId: string;
  organizerId: string;
  clubId?: string | null;
  seriesId?: string | null;
  startsAt: Date;
  endsAt: Date;
  localDate: string;
  status: ReservationStatus;
  hourlyRateCentsSnapshot: number;
  createdByAdminId?: string | null;
  /** null books without a hold (admin/comp); otherwise the checkout TTL. */
  holdExpiresAt: Date | null;
  participants: Array<{
    memberId: string;
    role: ParticipantRole;
    status: ParticipantStatus;
    invitedById?: string | null;
    viaClubId?: string | null;
  }>;
}

const detailInclude = {
  resourceType: true,
  resource: { select: { id: true, name: true } },
  participants: {
    include: { member: { select: { id: true, firstName: true, lastName: true, email: true } } },
    orderBy: { invitedAt: 'asc' as const },
  },
  payments: { orderBy: { createdAt: 'asc' as const } },
  claims: { select: { id: true, kind: true, status: true, expiresAt: true } },
  pendingChange: true,
} as const;

function toDetail(record: any): ReservationDetailRecord {
  const { claims, ...rest } = record;
  const claim = (claims as Array<{ id: string; kind: string; status: string; expiresAt: Date | null }>).find(
    (row) => row.kind === 'reservation',
  );
  return {
    ...rest,
    claim: claim ? { id: claim.id, status: claim.status, expiresAt: claim.expiresAt } : null,
  } as ReservationDetailRecord;
}

export class ReservationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private db(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async getDetail(id: string, tx?: TransactionContext): Promise<ReservationDetailRecord | null> {
    const record = await this.db(tx).reservation.findUnique({ where: { id }, include: detailInclude });
    return record ? toDetail(record) : null;
  }

  /** Everything the member organizes or participates in, any status. */
  async listForMember(
    memberId: string,
    filter: 'upcoming' | 'past' | 'all',
    now: Date = new Date(),
  ): Promise<ReservationDetailRecord[]> {
    const records = await this.prisma.reservation.findMany({
      where: {
        participants: { some: { memberId } },
        ...(filter === 'upcoming'
          ? { endsAt: { gte: now }, status: { in: ['pending_payment', 'confirmed'] } }
          : {}),
        ...(filter === 'past'
          ? { OR: [{ endsAt: { lt: now } }, { status: { in: ['cancelled', 'expired'] } }] }
          : {}),
      },
      include: detailInclude,
      orderBy: { startsAt: filter === 'past' ? 'desc' : 'asc' },
    });
    return records.map(toDetail);
  }

  /** Club-linked reservations (group activity), newest-first for past. */
  async listForClub(
    clubId: string,
    filter: 'upcoming' | 'past' | 'all',
    now: Date = new Date(),
  ): Promise<ReservationDetailRecord[]> {
    const records = await this.prisma.reservation.findMany({
      where: {
        clubId,
        ...(filter === 'upcoming'
          ? { endsAt: { gte: now }, status: { in: ['pending_payment', 'confirmed'] } }
          : {}),
        ...(filter === 'past'
          ? { OR: [{ endsAt: { lt: now } }, { status: { in: ['cancelled', 'expired'] } }] }
          : {}),
      },
      include: detailInclude,
      orderBy: { startsAt: filter === 'past' ? 'desc' : 'asc' },
    });
    return records.map(toDetail);
  }

  async listAll(options: { localDate?: string; includeInactive?: boolean } = {}): Promise<ReservationDetailRecord[]> {
    const records = await this.prisma.reservation.findMany({
      where: {
        ...(options.localDate ? { localDate: options.localDate } : {}),
        ...(options.includeInactive ? {} : { status: { in: ['pending_payment', 'confirmed'] } }),
      },
      include: detailInclude,
      orderBy: { startsAt: 'asc' },
    });
    return records.map(toDetail);
  }

  async countUpcomingForResources(resourceIds: string[], now: Date = new Date()): Promise<number> {
    if (resourceIds.length === 0) return 0;
    return this.prisma.reservation.count({
      where: {
        resourceId: { in: resourceIds },
        status: { in: ['pending_payment', 'confirmed'] },
        endsAt: { gte: now },
      },
    });
  }

  /**
   * The per-member daily limit is cross-aggregate: serialize the counting
   * writers per member with a transaction-scoped advisory lock.
   */
  async advisoryLockMember(tx: TransactionContext, memberId: string): Promise<void> {
    await asPrismaTx(tx).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;
  }

  /**
   * Serialize the mutating paths of ONE reservation (confirm, cancel,
   * reschedule, sweeper, refund settlement). The compare-and-set status
   * writes below are the correctness backstop; the lock is what lets a
   * money-settling transaction re-read the ledger knowing no concurrent
   * path is mid-settlement on the same reservation. Prefixed so the
   * keyspace cannot collide with the per-member lock. A transaction taking
   * both locks must take the member lock FIRST (consistent ordering).
   */
  async advisoryLockReservation(tx: TransactionContext, reservationId: string): Promise<void> {
    const key = `reservation:${reservationId}`;
    await asPrismaTx(tx).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  async countActiveOnDate(
    tx: TransactionContext | undefined,
    params: {
      organizerId: string;
      resourceTypeId: string;
      localDate: string;
      excludeReservationId?: string;
    },
  ): Promise<number> {
    return this.db(tx).reservation.count({
      where: {
        organizerId: params.organizerId,
        resourceTypeId: params.resourceTypeId,
        localDate: params.localDate,
        status: { in: ['pending_payment', 'confirmed'] },
        ...(params.excludeReservationId ? { NOT: { id: params.excludeReservationId } } : {}),
      },
    });
  }

  /**
   * A conflicting claim whose hold TTL lapsed before the sweeper ran is dead
   * weight: release it (and expire its reservation) so the insert can retry.
   * A hold whose payment actually succeeded is re-confirmed by the webhook
   * (confirm() recovers an expired-but-paid reservation) or refunded; the
   * slot is not kept hostage.
   *
   * Every write is compare-and-set, in the same order as every other
   * transition (reservation first, then claim): a hold confirmed mid-race
   * fails the pending_payment re-check under the row lock and is skipped
   * whole, so claim.status can never diverge from reservation.status.
   */
  async forceReleaseExpiredHolds(tx: TransactionContext, resourceIds: string[], now: Date): Promise<string[]> {
    if (resourceIds.length === 0) return [];
    const prisma = asPrismaTx(tx);
    const stale = await prisma.slotClaim.findMany({
      where: {
        resourceId: { in: resourceIds },
        kind: 'reservation',
        status: 'active',
        expiresAt: { lt: now },
      },
      select: { id: true, reservationId: true },
    });
    if (stale.length === 0) return [];

    const releasedIds: string[] = [];
    for (const claim of stale) {
      if (!claim.reservationId) continue;
      const expired = await prisma.reservation.updateMany({
        where: { id: claim.reservationId, status: 'pending_payment' },
        data: { status: 'expired' },
      });
      if (expired.count === 0) {
        // Lost the reservation row. A concurrent confirm re-armed the claim
        // (expiresAt cleared in the same transaction): leave it alone and
        // let the exclusion constraint reject our insert. Only a reservation
        // that is provably dead may have a leftover claim swept up.
        const fresh = await prisma.reservation.findUnique({
          where: { id: claim.reservationId },
          select: { status: true },
        });
        if (fresh && (fresh.status === 'expired' || fresh.status === 'cancelled')) {
          await prisma.slotClaim.updateMany({
            where: { id: claim.id, status: 'active', expiresAt: { lt: now } },
            data: { status: 'released', expiresAt: null },
          });
        }
        continue;
      }
      const released = await prisma.slotClaim.updateMany({
        where: { id: claim.id, status: 'active', expiresAt: { lt: now } },
        data: { status: 'released', expiresAt: null },
      });
      if (released.count > 0) releasedIds.push(claim.reservationId);
    }
    return releasedIds;
  }

  /**
   * The checkout write: reservation + participants + its ONE active claim in
   * the caller's transaction. The claim insert goes through raw SQL so a
   * lost claim race (SQLSTATE 23P01 or 40P01) maps to SlotUnavailableError
   * for the next-candidate retry.
   */
  async createWithClaim(tx: TransactionContext, input: CreateReservationInput): Promise<ReservationDetailRecord> {
    const prisma = asPrismaTx(tx);

    const reservation = await prisma.reservation.create({
      data: {
        resourceTypeId: input.resourceTypeId,
        resourceId: input.resourceId,
        organizerId: input.organizerId,
        clubId: input.clubId ?? null,
        seriesId: input.seriesId ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        localDate: input.localDate,
        status: input.status,
        hourlyRateCentsSnapshot: input.hourlyRateCentsSnapshot,
        createdByAdminId: input.createdByAdminId ?? null,
        participants: {
          create: input.participants.map((participant) => ({
            memberId: participant.memberId,
            role: participant.role,
            status: participant.status,
            invitedById: participant.invitedById ?? null,
            viaClubId: participant.viaClubId ?? null,
          })),
        },
      },
      select: { id: true },
    });

    try {
      await prisma.$executeRaw`
        INSERT INTO "slot_claims"
          ("id", "resourceId", "startsAt", "endsAt", "kind", "reservationId", "status", "expiresAt", "localDate", "createdAt", "updatedAt")
        VALUES
          (${createId()}, ${input.resourceId}, ${input.startsAt}, ${input.endsAt}, 'reservation', ${reservation.id}, 'active', ${input.holdExpiresAt}, ${input.localDate}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
    } catch (error) {
      if (isClaimConflictError(error)) throw new SlotUnavailableError();
      throw error;
    }

    return (await this.getDetail(reservation.id, tx))!;
  }

  /**
   * Reschedule: an UPDATE of the claim's range (and possibly resource). The
   * exclusion constraint checks the updated row against other rows only, so
   * overlap with the reservation's own old range is fine by construction.
   * The reservation row is written first, matching the row-lock order of
   * every other transition (reservation, then claim).
   */
  async moveClaimAndReservation(
    tx: TransactionContext,
    params: { reservationId: string; resourceId: string; startsAt: Date; endsAt: Date; localDate: string },
  ): Promise<void> {
    const prisma = asPrismaTx(tx);
    await prisma.reservation.update({
      where: { id: params.reservationId },
      data: {
        resourceId: params.resourceId,
        startsAt: params.startsAt,
        endsAt: params.endsAt,
        localDate: params.localDate,
      },
    });

    try {
      await prisma.$executeRaw`
        UPDATE "slot_claims"
        SET "resourceId" = ${params.resourceId},
            "startsAt" = ${params.startsAt},
            "endsAt" = ${params.endsAt},
            "localDate" = ${params.localDate},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "reservationId" = ${params.reservationId} AND "kind" = 'reservation'
      `;
    } catch (error) {
      if (isClaimConflictError(error)) throw new SlotUnavailableError();
      throw error;
    }
  }

  /**
   * Compare-and-set status transition. Every status write in the system goes
   * through this (or confirmFrom): an unconditional UPDATE-by-id would let a
   * transition that raced a concurrent one resurrect the loser's state
   * (confirm clobbering a cancel was the concrete bug). A false return means
   * the caller lost the race and must re-read instead of writing.
   */
  async transitionStatus(
    tx: TransactionContext,
    id: string,
    from: ReservationStatus[],
    to: ReservationStatus,
  ): Promise<boolean> {
    const updated = await asPrismaTx(tx).reservation.updateMany({
      where: { id, status: { in: from } },
      data: { status: to },
    });
    return updated.count > 0;
  }

  /**
   * Compare-and-set confirm: flips `from` -> confirmed, sets the paid total
   * and clears the hold TTL on the still-active claim in one transaction.
   * Exactly one concurrent confirmer (client, webhook, sweeper) sees true.
   */
  async confirmFrom(
    tx: TransactionContext,
    id: string,
    from: ReservationStatus,
    amountPaidCents: number,
  ): Promise<boolean> {
    const prisma = asPrismaTx(tx);
    const updated = await prisma.reservation.updateMany({
      where: { id, status: from },
      data: { status: 'confirmed', amountPaidCents },
    });
    if (updated.count === 0) return false;
    await prisma.slotClaim.updateMany({
      where: { reservationId: id, kind: 'reservation', status: 'active' },
      data: { expiresAt: null },
    });
    return true;
  }

  async releaseClaim(tx: TransactionContext, reservationId: string): Promise<void> {
    await asPrismaTx(tx).slotClaim.updateMany({
      where: { reservationId, kind: 'reservation', status: 'active' },
      data: { status: 'released', expiresAt: null },
    });
  }

  /**
   * Re-arm a released reservation claim (expired-but-paid recovery). The
   * exclusion constraint arbitrates against whoever claimed the range in the
   * meantime; a lost race maps to SlotUnavailableError. Returns false when
   * there is no released claim to re-arm.
   */
  async reactivateClaim(tx: TransactionContext, reservationId: string): Promise<boolean> {
    const prisma = asPrismaTx(tx);
    try {
      const count = await prisma.$executeRaw`
        UPDATE "slot_claims"
        SET "status" = 'active', "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "reservationId" = ${reservationId} AND "kind" = 'reservation' AND "status" = 'released'
      `;
      return count > 0;
    } catch (error) {
      if (isClaimConflictError(error)) throw new SlotUnavailableError();
      throw error;
    }
  }

  async adjustAmountPaid(tx: TransactionContext, id: string, deltaCents: number): Promise<void> {
    await asPrismaTx(tx).reservation.update({
      where: { id },
      data: { amountPaidCents: { increment: deltaCents } },
    });
  }

  // ── Payments ──

  async addPayment(
    tx: TransactionContext | undefined,
    data: {
      reservationId: string;
      kind: 'charge' | 'refund';
      purpose?: 'base' | 'change_delta';
      amountCents: number;
      stripePaymentIntentId?: string | null;
      stripeRefundId?: string | null;
      status: 'pending' | 'succeeded' | 'failed';
    },
  ): Promise<ReservationPayment> {
    return this.db(tx).reservationPayment.create({
      data: {
        reservationId: data.reservationId,
        kind: data.kind,
        purpose: data.purpose ?? 'base',
        amountCents: data.amountCents,
        stripePaymentIntentId: data.stripePaymentIntentId ?? null,
        stripeRefundId: data.stripeRefundId ?? null,
        status: data.status,
      },
    }) as unknown as ReservationPayment;
  }

  /** The charge row of a reservation for a specific PaymentIntent. */
  async findChargeByPaymentIntent(
    tx: TransactionContext | undefined,
    reservationId: string,
    stripePaymentIntentId: string,
  ): Promise<ReservationPayment | null> {
    return this.db(tx).reservationPayment.findFirst({
      where: { reservationId, kind: 'charge', stripePaymentIntentId },
    }) as unknown as ReservationPayment | null;
  }

  /** Which reservation a PaymentIntent belongs to (charge-row linkage). */
  async findReservationIdByPaymentIntent(stripePaymentIntentId: string): Promise<string | null> {
    const row = await this.prisma.reservationPayment.findFirst({
      where: { kind: 'charge', stripePaymentIntentId },
      select: { reservationId: true },
    });
    return row?.reservationId ?? null;
  }

  /** Persist the refund percent a cancellation applied (TOCTOU repair key). */
  async setCancelRefundPercent(tx: TransactionContext, id: string, percent: number): Promise<void> {
    await asPrismaTx(tx).reservation.update({
      where: { id },
      data: { cancelRefundPercent: percent },
    });
  }

  /**
   * Compare-and-set payment status flip; false means another path already
   * moved the row, so the caller must not double-book its side effects.
   */
  async setPaymentStatusIf(
    tx: TransactionContext,
    paymentId: string,
    expected: 'pending' | 'succeeded' | 'failed',
    next: 'pending' | 'succeeded' | 'failed',
  ): Promise<boolean> {
    const updated = await asPrismaTx(tx).reservationPayment.updateMany({
      where: { id: paymentId, status: expected },
      data: { status: next },
    });
    return updated.count > 0;
  }

  /** Marks a reserved (pending) refund row as executed at Stripe. */
  async completeRefund(tx: TransactionContext, paymentId: string, stripeRefundId: string): Promise<boolean> {
    const updated = await asPrismaTx(tx).reservationPayment.updateMany({
      where: { id: paymentId, kind: 'refund', status: 'pending' },
      data: { status: 'succeeded', stripeRefundId },
    });
    return updated.count > 0;
  }

  /** Refund row by its Stripe refund id (billing webhook reconciliation). */
  async findPaymentByStripeRefundId(
    stripeRefundId: string,
    tx?: TransactionContext,
  ): Promise<ReservationPayment | null> {
    return this.db(tx).reservationPayment.findFirst({
      where: { stripeRefundId, kind: 'refund' },
    }) as unknown as ReservationPayment | null;
  }

  /** Payment row by primary key (refund adoption resolves refundKey = id). */
  async getPaymentById(paymentId: string, tx?: TransactionContext): Promise<ReservationPayment | null> {
    return this.db(tx).reservationPayment.findUnique({
      where: { id: paymentId },
    }) as unknown as ReservationPayment | null;
  }

  /**
   * Stamp an externally-observed Stripe refund id onto the reserved row it
   * originated from (refundKey = row id). Compare-and-set on the id still
   * being NULL: false means completeRefund (or a concurrent adopter)
   * already stamped it, and by construction of the per-row idempotency key
   * it can only ever be the SAME refund id.
   */
  async adoptReservedRefund(
    tx: TransactionContext,
    paymentId: string,
    stripeRefundId: string,
  ): Promise<boolean> {
    const updated = await asPrismaTx(tx).reservationPayment.updateMany({
      where: { id: paymentId, kind: 'refund', stripeRefundId: null },
      data: { stripeRefundId },
    });
    return updated.count > 0;
  }

  /**
   * Reserved refunds that never reached Stripe: still pending, no
   * stripeRefundId, old enough that no phase-2 execution is plausibly in
   * flight. The nightly reconcile re-drives them (idempotency key = row id).
   */
  async listStalePendingRefunds(olderThan: Date): Promise<ReservationPayment[]> {
    return this.prisma.reservationPayment.findMany({
      where: {
        kind: 'refund',
        status: 'pending',
        stripeRefundId: null,
        stripePaymentIntentId: { not: null },
        createdAt: { lt: olderThan },
      },
      orderBy: { createdAt: 'asc' },
    }) as unknown as ReservationPayment[];
  }

  /**
   * Financial freeze (charge.dispute.created): stamp the disputed charge so
   * the allocator excludes it from refundable balance. Returns the frozen
   * rows' reservation ids (usually one).
   */
  async markChargeDisputed(stripePaymentIntentId: string, when: Date): Promise<string[]> {
    const rows = await this.prisma.reservationPayment.findMany({
      where: { stripePaymentIntentId, kind: 'charge', disputedAt: null },
      select: { id: true, reservationId: true },
    });
    if (rows.length === 0) return [];
    await this.prisma.reservationPayment.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { disputedAt: when },
    });
    return [...new Set(rows.map((row) => row.reservationId))];
  }

  /**
   * Billing-side blockers for account closure (package E): refunds still in
   * flight and disputed charges on the member's reservations.
   */
  async countBlockingFinancialState(memberId: string): Promise<{ pendingRefunds: number; disputedCharges: number }> {
    const [pendingRefunds, disputedCharges] = await Promise.all([
      this.prisma.reservationPayment.count({
        where: { kind: 'refund', status: 'pending', reservation: { organizerId: memberId } },
      }),
      this.prisma.reservationPayment.count({
        where: { kind: 'charge', disputedAt: { not: null }, reservation: { organizerId: memberId } },
      }),
    ]);
    return { pendingRefunds, disputedCharges };
  }

  // ── Participants ──

  async getParticipant(
    tx: TransactionContext | undefined,
    reservationId: string,
    memberId: string,
  ): Promise<ReservationParticipant | null> {
    return this.db(tx).reservationParticipant.findUnique({
      where: { reservationId_memberId: { reservationId, memberId } },
    }) as unknown as ReservationParticipant | null;
  }

  /**
   * Invite (or re-invite a declined/withdrawn row) as pending. The caller
   * must skip members who are already pending or confirmed; the upsert
   * against @@unique([reservationId, memberId]) makes "add all" idempotent.
   */
  async upsertPendingInvite(
    tx: TransactionContext,
    params: { reservationId: string; memberId: string; invitedById: string; viaClubId?: string | null },
  ): Promise<void> {
    await asPrismaTx(tx).reservationParticipant.upsert({
      where: { reservationId_memberId: { reservationId: params.reservationId, memberId: params.memberId } },
      create: {
        reservationId: params.reservationId,
        memberId: params.memberId,
        role: 'guest',
        status: 'pending',
        invitedById: params.invitedById,
        viaClubId: params.viaClubId ?? null,
      },
      update: {
        status: 'pending',
        invitedById: params.invitedById,
        viaClubId: params.viaClubId ?? null,
        invitedAt: new Date(),
        respondedAt: null,
      },
    });
  }

  async updateParticipantStatus(
    tx: TransactionContext,
    participantId: string,
    status: ParticipantStatus,
    respondedAt: Date,
  ): Promise<void> {
    await asPrismaTx(tx).reservationParticipant.update({
      where: { id: participantId },
      data: { status, respondedAt },
    });
  }

  async deleteParticipant(tx: TransactionContext, participantId: string): Promise<void> {
    await asPrismaTx(tx).reservationParticipant.delete({ where: { id: participantId } });
  }

  /** Reschedule resets confirmed guests to pending; returns who was reset. */
  async resetConfirmedGuestsToPending(tx: TransactionContext, reservationId: string): Promise<string[]> {
    const prisma = asPrismaTx(tx);
    const confirmed = await prisma.reservationParticipant.findMany({
      where: { reservationId, role: 'guest', status: 'confirmed' },
      select: { id: true, memberId: true },
    });
    if (confirmed.length === 0) return [];

    await prisma.reservationParticipant.updateMany({
      where: { id: { in: confirmed.map((participant) => participant.id) } },
      data: { status: 'pending', respondedAt: null },
    });
    return confirmed.map((participant) => participant.memberId);
  }

  // ── Pending changes (reschedule-grow awaiting its delta charge) ──

  async createPendingChange(
    tx: TransactionContext,
    input: {
      reservationId: string;
      resourceId: string;
      startsAt: Date;
      endsAt: Date;
      localDate: string;
      deltaCents: number;
      chargePaymentId: string;
      expiresAt: Date;
    },
  ): Promise<void> {
    await asPrismaTx(tx).reservationPendingChange.create({ data: input });
  }

  async clearPendingChange(tx: TransactionContext, reservationId: string): Promise<boolean> {
    const deleted = await asPrismaTx(tx).reservationPendingChange.deleteMany({
      where: { reservationId },
    });
    return deleted.count > 0;
  }

  async listExpiredPendingChanges(now: Date): Promise<ReservationDetailRecord[]> {
    const records = await this.prisma.reservation.findMany({
      where: { pendingChange: { is: { expiresAt: { lt: now } } } },
      include: detailInclude,
    });
    return records.map(toDetail);
  }

  // ── Sweeper ──

  async listExpiredHolds(now: Date, resourceIds?: string[]): Promise<ReservationDetailRecord[]> {
    const records = await this.prisma.reservation.findMany({
      where: {
        status: 'pending_payment',
        claims: {
          some: {
            kind: 'reservation',
            status: 'active',
            expiresAt: { lt: now },
            ...(resourceIds ? { resourceId: { in: resourceIds } } : {}),
          },
        },
      },
      include: detailInclude,
    });
    return records.map(toDetail);
  }

  // ── Member existence ──
  // The members BC owns this table; scheduling only checks invitee existence
  // and never mutates. A members-context API can replace this read later.

  async filterExistingMemberIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const members = await this.prisma.member.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return new Set(members.map((member) => member.id));
  }
}
