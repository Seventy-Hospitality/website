import type { UnitOfWork } from '@/lib/kernel';
import type { EventClaimConflict, ResourceClaimPort } from '@/lib/contexts/bookings';
import { EventClaimConflictError } from '@/lib/contexts/bookings';
import {
  ClubEventCourtConflictError,
  ClubEventCourtNotFoundError,
  type ClubEvent,
  type ClubEventCourt,
  ClubEventNotFoundError,
  ClubEventValidationError,
  clubEventInvariants,
  type ClubEventCourtConflict,
} from '../domain';
import type { ClubEventRepository, ClubEventRow, ClubEventWriteData, ListClubEventsOptions } from '../infrastructure';

export interface CreateClubEventInput {
  title: string;
  imageUrl?: string | null;
  details?: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  active?: boolean;
  courtIds?: string[];
  cancelConflictingBookings?: boolean;
  actorId?: string;
}

export interface UpdateClubEventInput {
  title?: string;
  imageUrl?: string | null;
  details?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  timezone?: string;
  active?: boolean;
  courtIds?: string[];
  cancelConflictingBookings?: boolean;
  actorId?: string;
}

interface ManagedEventImageStore {
  deleteManagedAsset(publicPath: string | null | undefined): Promise<void>;
  isManagedAsset(publicPath: string | null | undefined): boolean;
  attachManagedAssetToOwner(
    publicPath: string | null | undefined,
    owner: { ownerType: string; ownerId: string },
  ): Promise<void>;
}

/**
 * Club events claim courts exclusively through the scheduling BC's
 * ResourceClaimPort: the events context never writes slot_claims itself, so
 * the DB exclusion constraint stays the single no-overlap arbiter between
 * event blocks and member reservations.
 */
export class ClubEventService {
  constructor(
    private readonly repo: ClubEventRepository,
    private readonly claimPort: ResourceClaimPort,
    private readonly mediaStore: ManagedEventImageStore,
    private readonly uow: UnitOfWork,
  ) {}

  async list(query: ListClubEventsOptions): Promise<ClubEvent[]> {
    const rows = await this.repo.list(query);
    return this.composeCourts(rows);
  }

  async getById(id: string): Promise<ClubEvent> {
    const row = await this.repo.getById(id);
    if (!row) throw new ClubEventNotFoundError(id);
    const [event] = await this.composeCourts([row]);
    return event;
  }

  async create(input: CreateClubEventInput): Promise<ClubEvent> {
    const { data, courtIds, courts } = await this.prepareWrite(input);
    await this.resolveConflicts(data, courtIds, input.cancelConflictingBookings ?? false, input.actorId);

    const row = await this.runClaimingWrite(data, courtIds, (tx) =>
      this.repo.create(tx, data).then(async (created) => {
        await this.claimPort.syncEventClaims(tx, {
          eventId: created.id,
          resourceIds: courtIds,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          active: data.active,
        });
        return created;
      }),
    );

    await this.attachEventImage(row.imageUrl, row.id);
    return { ...row, courts };
  }

  async update(id: string, input: UpdateClubEventInput): Promise<ClubEvent> {
    const existingRow = await this.repo.getById(id);
    if (!existingRow) throw new ClubEventNotFoundError(id);
    const [existing] = await this.composeCourts([existingRow]);

    const { data, courtIds, courts } = await this.prepareWrite(input, existing);
    await this.resolveConflicts(data, courtIds, input.cancelConflictingBookings ?? false, input.actorId);

    const row = await this.runClaimingWrite(data, courtIds, async (tx) => {
      const updated = await this.repo.update(tx, id, data);
      await this.claimPort.syncEventClaims(tx, {
        eventId: id,
        resourceIds: courtIds,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        active: data.active,
      });
      return updated;
    });

    await this.attachEventImage(row.imageUrl, row.id);
    await this.cleanupReplacedManagedImage(existing.imageUrl, row.imageUrl);
    return { ...row, courts };
  }

  // ── Internals ──

  private async composeCourts(rows: ClubEventRow[]): Promise<ClubEvent[]> {
    if (rows.length === 0) return [];
    const byEvent = await this.claimPort.listResourcesForEvents(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, courts: byEvent.get(row.id) ?? [] }));
  }

  private async prepareWrite(
    input: CreateClubEventInput | UpdateClubEventInput,
    existing?: ClubEvent,
  ): Promise<{ data: ClubEventWriteData; courtIds: string[]; courts: ClubEventCourt[] }> {
    const data: ClubEventWriteData = {
      title: input.title ?? existing?.title ?? '',
      imageUrl: input.imageUrl === undefined ? existing?.imageUrl ?? null : input.imageUrl ?? null,
      details: input.details === undefined ? existing?.details ?? null : input.details ?? null,
      startsAt: input.startsAt ?? existing?.startsAt ?? new Date(Number.NaN),
      endsAt: input.endsAt ?? existing?.endsAt ?? new Date(Number.NaN),
      timezone: input.timezone ?? existing?.timezone ?? '',
      active: input.active ?? existing?.active ?? true,
    };

    clubEventInvariants.validateTitle(data.title);
    clubEventInvariants.validateTimezone(data.timezone);
    clubEventInvariants.validateSchedule(data.startsAt, data.endsAt);
    this.validateEventImage(data.imageUrl);

    const courtIds = this.normalizeCourtIds(
      input.courtIds ?? existing?.courts.map((court) => court.id) ?? [],
    );
    const courts = await this.loadCourts(courtIds);
    return { data, courtIds, courts };
  }

  private validateEventImage(imageUrl: string | null) {
    if (!imageUrl) {
      return;
    }

    if (!this.mediaStore.isManagedAsset(imageUrl)) {
      throw new ClubEventValidationError('Event images must be uploaded through the media endpoint');
    }
  }

  private normalizeCourtIds(ids?: string[]) {
    return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
  }

  private async loadCourts(courtIds: string[]): Promise<ClubEventCourt[]> {
    if (courtIds.length === 0) return [];

    const courts = await this.claimPort.getResourcesByIds(courtIds);
    if (courts.length !== courtIds.length) {
      const foundIds = new Set(courts.map((court) => court.id));
      throw new ClubEventCourtNotFoundError(courtIds.filter((id) => !foundIds.has(id)));
    }

    return courts;
  }

  /**
   * Pre-flight conflict listing (admin sees who is in the way), optional
   * forced cancellation with full refund, and the write itself. A conflict
   * that appears between pre-flight and the claim insert loses to the
   * exclusion constraint and surfaces as the same 409.
   */
  private async resolveConflicts(
    data: ClubEventWriteData,
    courtIds: string[],
    cancelConflictingBookings: boolean,
    actorId?: string,
  ) {
    if (!data.active || courtIds.length === 0) return;

    const conflicts = await this.claimPort.listEventConflicts(courtIds, data.startsAt, data.endsAt);
    if (conflicts.length === 0) return;

    if (!cancelConflictingBookings) {
      throw new ClubEventCourtConflictError(conflicts.map(toLegacyConflict));
    }

    await this.claimPort.cancelReservations(
      conflicts.map((conflict) => conflict.reservationId),
      actorId,
    );
  }

  private async runClaimingWrite(
    data: ClubEventWriteData,
    courtIds: string[],
    write: (tx: Parameters<Parameters<UnitOfWork['execute']>[0]>[0]) => Promise<ClubEventRow>,
  ): Promise<ClubEventRow> {
    try {
      return await this.uow.execute(write);
    } catch (error) {
      if (error instanceof EventClaimConflictError) {
        // Lost a race after pre-flight; re-list for a useful payload.
        const conflicts = await this.claimPort.listEventConflicts(courtIds, data.startsAt, data.endsAt);
        throw new ClubEventCourtConflictError(conflicts.map(toLegacyConflict));
      }
      throw error;
    }
  }

  private async cleanupReplacedManagedImage(previousImageUrl: string | null, nextImageUrl: string | null) {
    if (!previousImageUrl || previousImageUrl === nextImageUrl) {
      return;
    }

    await this.mediaStore.deleteManagedAsset(previousImageUrl);
  }

  private async attachEventImage(imageUrl: string | null, eventId: string) {
    await this.mediaStore.attachManagedAssetToOwner(imageUrl, {
      ownerType: 'club-event',
      ownerId: eventId,
    });
  }
}

/** Keep the admin-web wire shape of conflicts stable across the cutover. */
function toLegacyConflict(conflict: EventClaimConflict): ClubEventCourtConflict {
  return {
    bookingId: conflict.reservationId,
    courtId: conflict.resourceId,
    courtName: conflict.resourceName,
    memberId: conflict.organizerId,
    memberName: conflict.organizerName,
    memberEmail: conflict.organizerEmail,
    date: conflict.localDate,
    startTime: conflict.startTime,
    endTime: conflict.endTime,
  };
}
