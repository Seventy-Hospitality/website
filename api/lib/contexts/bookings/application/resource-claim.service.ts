import type { TransactionContext } from '@/lib/kernel';
import { minutesToTimeLabel, zonedDateKey, zonedMinutesSinceMidnight } from '@/lib/kernel';
import {
  type ClaimedResource,
  type EventClaimConflict,
  type ResourceClaimPort,
  EventClaimConflictError,
  InvalidReservationStatusError,
  SlotUnavailableError,
} from '../domain';
import type { ResourceRepository } from '../infrastructure/resource.repository';
import type { SlotClaimRepository } from '../infrastructure/slot-claim.repository';
import type { ReservationService } from './reservation.service';

/**
 * The scheduling BC's claim facade for the events BC: club events block
 * courts through slot_claims rows of kind 'event', written here and nowhere
 * else, so the exclusion constraint stays the single no-overlap arbiter for
 * member reservations and event blocks alike.
 */
export class ResourceClaimService implements ResourceClaimPort {
  constructor(
    private readonly resourceRepo: ResourceRepository,
    private readonly claimRepo: SlotClaimRepository,
    private readonly reservationService: ReservationService,
    private readonly timezone: string,
  ) {}

  async getResourcesByIds(ids: string[]): Promise<ClaimedResource[]> {
    const resources = await this.resourceRepo.listByIds(ids);
    return resources.map((resource) => ({ id: resource.id, name: resource.name }));
  }

  async listResourcesForEvents(eventIds: string[]): Promise<Map<string, ClaimedResource[]>> {
    return this.claimRepo.listEventResources(eventIds);
  }

  async listEventConflicts(
    resourceIds: string[],
    startsAt: Date,
    endsAt: Date,
  ): Promise<EventClaimConflict[]> {
    const conflicts = await this.claimRepo.listReservationConflicts(resourceIds, startsAt, endsAt);
    return conflicts.map((conflict) => ({
      reservationId: conflict.reservationId,
      reference: conflict.reference,
      resourceId: conflict.resourceId,
      resourceName: conflict.resourceName,
      organizerId: conflict.organizer.id,
      organizerName: `${conflict.organizer.firstName} ${conflict.organizer.lastName}`.trim(),
      organizerEmail: conflict.organizer.email,
      localDate: conflict.localDate,
      startTime: minutesToTimeLabel(
        zonedMinutesSinceMidnight(conflict.startsAt, this.timezone, conflict.localDate),
      ),
      endTime: minutesToTimeLabel(
        zonedMinutesSinceMidnight(conflict.endsAt, this.timezone, conflict.localDate),
      ),
    }));
  }

  /** Admin clears the way for an event: full refund, the club cancelled. */
  async cancelReservations(reservationIds: string[], actorId?: string): Promise<void> {
    for (const reservationId of [...new Set(reservationIds)]) {
      try {
        await this.reservationService.cancel(reservationId, { fullRefund: true, actorId });
      } catch (error) {
        // Already cancelled/expired between pre-flight and now: nothing to do.
        if (error instanceof InvalidReservationStatusError) continue;
        throw error;
      }
    }
  }

  async syncEventClaims(
    tx: TransactionContext,
    input: { eventId: string; resourceIds: string[]; startsAt: Date; endsAt: Date; active: boolean },
  ): Promise<void> {
    await this.claimRepo.deleteEventClaims(tx, input.eventId);
    if (input.resourceIds.length === 0) return;

    const localDate = zonedDateKey(input.startsAt, this.timezone);
    try {
      await this.claimRepo.insertEventClaims(
        tx,
        input.eventId,
        input.resourceIds.map((resourceId) => ({
          resourceId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          localDate,
        })),
        // Inactive events keep their court selection as released claims,
        // which never block availability.
        input.active ? 'active' : 'released',
      );
    } catch (error) {
      if (error instanceof SlotUnavailableError) {
        // The transaction is aborting; the caller re-lists conflicts outside
        // it to produce a useful error payload.
        throw new EventClaimConflictError([]);
      }
      throw error;
    }
  }
}
