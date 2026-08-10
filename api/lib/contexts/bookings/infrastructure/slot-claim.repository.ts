import { createId } from '@paralleldrive/cuid2';
import type { PrismaClient } from '@prisma/client';
import type { TransactionContext } from '@/lib/kernel';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { ClaimRange, ClaimedResource } from '../domain';
import { SlotUnavailableError } from '../domain';
import { isClaimConflictError } from './pg-errors';

export interface ReservationClaimConflictRecord {
  reservationId: string;
  reference: string;
  resourceId: string;
  resourceName: string;
  startsAt: Date;
  endsAt: Date;
  localDate: string;
  organizer: { id: string; firstName: string; lastName: string; email: string };
}

/**
 * Reads and event-claim writes on slot_claims. Reservation-claim writes live
 * in ReservationRepository (they are part of the reservation aggregate);
 * both go through raw SQL for inserts/updates so a lost claim race (SQLSTATE
 * 23P01/40P01) surfaces deterministically.
 */
export class SlotClaimRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private db(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  /** Active claims overlapping a window, for availability computation. */
  async listActiveInWindow(
    resourceIds: string[],
    from: Date,
    to: Date,
    options: { excludeReservationId?: string } = {},
  ): Promise<ClaimRange[]> {
    if (resourceIds.length === 0) return [];
    const claims = await this.prisma.slotClaim.findMany({
      where: {
        resourceId: { in: resourceIds },
        status: 'active',
        startsAt: { lt: to },
        endsAt: { gt: from },
        ...(options.excludeReservationId ? { NOT: { reservationId: options.excludeReservationId } } : {}),
      },
      select: { resourceId: true, startsAt: true, endsAt: true },
    });
    return claims;
  }

  /** Member reservations whose active claim overlaps a range (event pre-flight). */
  async listReservationConflicts(
    resourceIds: string[],
    startsAt: Date,
    endsAt: Date,
  ): Promise<ReservationClaimConflictRecord[]> {
    if (resourceIds.length === 0) return [];
    const claims = await this.prisma.slotClaim.findMany({
      where: {
        kind: 'reservation',
        status: 'active',
        resourceId: { in: resourceIds },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      include: {
        resource: { select: { name: true } },
        reservation: {
          select: {
            id: true,
            reference: true,
            organizer: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    });

    return claims
      .filter((claim) => claim.reservation !== null)
      .map((claim) => ({
        reservationId: claim.reservation!.id,
        reference: claim.reservation!.reference,
        resourceId: claim.resourceId,
        resourceName: claim.resource.name,
        startsAt: claim.startsAt,
        endsAt: claim.endsAt,
        localDate: claim.localDate,
        organizer: claim.reservation!.organizer,
      }));
  }

  /** Resources each event currently claims (any status), for serialization. */
  async listEventResources(eventIds: string[]): Promise<Map<string, ClaimedResource[]>> {
    if (eventIds.length === 0) return new Map();
    const claims = await this.prisma.slotClaim.findMany({
      where: { kind: 'event', clubEventId: { in: eventIds } },
      include: { resource: { select: { id: true, name: true } } },
      orderBy: { resource: { name: 'asc' } },
    });

    const byEvent = new Map<string, ClaimedResource[]>();
    for (const claim of claims) {
      const list = byEvent.get(claim.clubEventId!) ?? [];
      if (!list.some((resource) => resource.id === claim.resource.id)) {
        list.push({ id: claim.resource.id, name: claim.resource.name });
      }
      byEvent.set(claim.clubEventId!, list);
    }
    return byEvent;
  }

  async deleteEventClaims(tx: TransactionContext, eventId: string): Promise<void> {
    await this.db(tx).slotClaim.deleteMany({ where: { kind: 'event', clubEventId: eventId } });
  }

  /**
   * Insert one claim per resource for an event. Claims of inactive events
   * are kept as 'released' (the court selection survives a deactivate) and
   * fall outside the exclusion constraint's partial predicate; active claims
   * are arbitrated by it, and a lost race maps to SlotUnavailableError.
   */
  async insertEventClaims(
    tx: TransactionContext,
    eventId: string,
    claims: Array<{ resourceId: string; startsAt: Date; endsAt: Date; localDate: string }>,
    status: 'active' | 'released',
  ): Promise<void> {
    const prisma = this.db(tx);
    for (const claim of claims) {
      try {
        await prisma.$executeRaw`
          INSERT INTO "slot_claims"
            ("id", "resourceId", "startsAt", "endsAt", "kind", "clubEventId", "status", "localDate", "createdAt", "updatedAt")
          VALUES
            (${createId()}, ${claim.resourceId}, ${claim.startsAt}, ${claim.endsAt}, 'event', ${eventId}, ${status}, ${claim.localDate}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
      } catch (error) {
        if (isClaimConflictError(error)) throw new SlotUnavailableError();
        throw error;
      }
    }
  }
}
