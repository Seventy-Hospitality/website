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
   * A hold whose payment actually succeeded is re-confirmed by the webhook or
   * refunded by billing; the slot is not kept hostage.
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

    await prisma.slotClaim.updateMany({
      where: { id: { in: stale.map((claim) => claim.id) } },
      data: { status: 'released' },
    });
    const reservationIds = stale.map((claim) => claim.reservationId!).filter(Boolean);
    await prisma.reservation.updateMany({
      where: { id: { in: reservationIds }, status: 'pending_payment' },
      data: { status: 'expired' },
    });
    return reservationIds;
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
   */
  async moveClaimAndReservation(
    tx: TransactionContext,
    params: { reservationId: string; resourceId: string; startsAt: Date; endsAt: Date; localDate: string },
  ): Promise<void> {
    const prisma = asPrismaTx(tx);
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

    await prisma.reservation.update({
      where: { id: params.reservationId },
      data: {
        resourceId: params.resourceId,
        startsAt: params.startsAt,
        endsAt: params.endsAt,
        localDate: params.localDate,
      },
    });
  }

  async updateStatus(tx: TransactionContext, id: string, status: ReservationStatus): Promise<void> {
    await asPrismaTx(tx).reservation.update({ where: { id }, data: { status } });
  }

  async confirmReservation(tx: TransactionContext, id: string, amountPaidCents: number): Promise<void> {
    const prisma = asPrismaTx(tx);
    await prisma.reservation.update({ where: { id }, data: { status: 'confirmed', amountPaidCents } });
    await prisma.slotClaim.updateMany({
      where: { reservationId: id, kind: 'reservation' },
      data: { expiresAt: null },
    });
  }

  async releaseClaim(tx: TransactionContext, reservationId: string): Promise<void> {
    await asPrismaTx(tx).slotClaim.updateMany({
      where: { reservationId, kind: 'reservation', status: 'active' },
      data: { status: 'released', expiresAt: null },
    });
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
        amountCents: data.amountCents,
        stripePaymentIntentId: data.stripePaymentIntentId ?? null,
        stripeRefundId: data.stripeRefundId ?? null,
        status: data.status,
      },
    }) as unknown as ReservationPayment;
  }

  async setPaymentStatus(tx: TransactionContext, paymentId: string, status: 'pending' | 'succeeded' | 'failed'): Promise<void> {
    await asPrismaTx(tx).reservationPayment.update({ where: { id: paymentId }, data: { status } });
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

  // ── Sweeper ──

  async listExpiredHolds(now: Date): Promise<ReservationDetailRecord[]> {
    const records = await this.prisma.reservation.findMany({
      where: {
        status: 'pending_payment',
        claims: { some: { kind: 'reservation', status: 'active', expiresAt: { lt: now } } },
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
