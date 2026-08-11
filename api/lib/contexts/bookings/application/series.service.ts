import type { UnitOfWork } from '@/lib/kernel';
import { minutesToTimeLabel, timeLabelToMinutes } from '@/lib/kernel';
import {
  type ResourceType,
  listSeriesOccurrenceDates,
  parseSlotSelection,
  DuplicateSeriesOccurrenceError,
  InactiveMembershipError,
  InvalidSlotSelectionError,
  InviteeNotFoundError,
  MaxReservationsExceededError,
  ResourceTypeNotFoundError,
  SeriesNotFoundError,
  SlotUnavailableError,
} from '../domain';
import type {
  ReservationSeriesRepository,
  SeriesAdminRecord,
  SeriesRecord,
} from '../infrastructure/series.repository';
import type { ReservationRepository } from '../infrastructure/reservation.repository';
import type { ResourceTypeRepository } from '../infrastructure/resource.repository';
import type { AuditLog } from './ports';
import type { ReservationService } from './reservation.service';

const STREAM_TYPE = 'reservation_series';

export interface CreateSeriesInput {
  organizerId: string;
  typeCode: string;
  weekday: number; // 0 = Sunday .. 6 = Saturday, venue-local
  startTime: string; // "HH:MM" venue wall clock
  durationMinutes: number;
  adminUserId: string;
}

export interface MaterializeResult {
  series: number;
  created: number;
  skipped: number;
  alreadyHandled: number;
}

/**
 * Weekly recurrence (plan OPEN decision 8: infra + badge now, creation
 * admin-only). A series is a venue-local weekday + wall time; the
 * materialize cron turns it into concrete reservations inside the type's
 * booking horizon. Materialized occurrences are COMP reservations (admin
 * semantics: confirmed immediately, no payment) carrying seriesId, which is
 * the Weekly badge. An occurrence that cannot be created (slot collision,
 * daily limit, lapsed membership) is SKIPPED and the organizer notified
 * exactly once, never silently shifted; the skip marker plus the
 * (seriesId, localDate) partial unique make repeated passes and concurrent
 * crons idempotent.
 */
export class SeriesService {
  constructor(
    private readonly seriesRepo: ReservationSeriesRepository,
    private readonly typeRepo: ResourceTypeRepository,
    private readonly reservationRepo: ReservationRepository,
    private readonly reservationService: ReservationService,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly timezone: string,
  ) {}

  // ── Admin surface ──

  async create(input: CreateSeriesInput): Promise<SeriesAdminRecord> {
    const type = await this.typeRepo.getByCode(input.typeCode);
    if (!type || !type.active) throw new ResourceTypeNotFoundError(input.typeCode);
    if (input.weekday < 0 || input.weekday > 6 || !Number.isInteger(input.weekday)) {
      throw new InvalidSlotSelectionError('weekday must be 0 (Sunday) through 6 (Saturday)');
    }

    // Grid + operating-hours validation via the same slot parser bookings
    // use: the series must describe a bookable contiguous range.
    parseSlotSelection(this.slotLabels(type, input.startTime, input.durationMinutes), {
      slotDurationMinutes: type.slotDurationMinutes,
      opStartMinutes: type.opStartMinutes,
      opEndMinutes: type.opEndMinutes,
    });

    const organizerExists = await this.reservationRepo.filterExistingMemberIds([input.organizerId]);
    if (!organizerExists.has(input.organizerId)) throw new InviteeNotFoundError([input.organizerId]);

    const series = await this.seriesRepo.create({
      organizerId: input.organizerId,
      resourceTypeId: type.id,
      weekday: input.weekday,
      startTimeLocal: input.startTime,
      durationMinutes: input.durationMinutes,
      createdByAdminId: input.adminUserId,
    });

    await this.uow.execute(async (tx) => {
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: series.id,
        eventType: 'reservation_series.created',
        data: {
          organizerId: input.organizerId,
          typeCode: type.code,
          weekday: input.weekday,
          startTimeLocal: input.startTime,
          durationMinutes: input.durationMinutes,
        },
        actorId: input.adminUserId,
      });
    });

    return series;
  }

  async list(): Promise<SeriesAdminRecord[]> {
    return this.seriesRepo.list();
  }

  /**
   * Cancel a series: stop future materialization AND cancel its
   * still-upcoming materialized occurrences (comp reservations, so the
   * full-refund path refunds nothing but releases the claims and notifies
   * participants through the usual reservation.cancelled events).
   */
  async cancel(
    id: string,
    adminUserId: string,
    now: Date = new Date(),
  ): Promise<{ cancelled: boolean; occurrencesCancelled: number }> {
    const series = await this.seriesRepo.getById(id);
    if (!series) throw new SeriesNotFoundError(id);

    const cancelled = await this.seriesRepo.deactivate(id);
    if (cancelled) {
      await this.uow.execute(async (tx) => {
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: id,
          eventType: 'reservation_series.cancelled',
          data: { organizerId: series.organizerId },
          actorId: adminUserId,
        });
      });
    }

    let occurrencesCancelled = 0;
    for (const occurrence of await this.seriesRepo.listFutureActiveOccurrences(id, now)) {
      await this.reservationService.cancel(occurrence.id, {
        fullRefund: true,
        actorId: adminUserId,
        now,
      });
      occurrencesCancelled += 1;
    }

    return { cancelled, occurrencesCancelled };
  }

  // ── Materialization (cron) ──

  async materializeDue(now: Date = new Date()): Promise<MaterializeResult> {
    const result: MaterializeResult = { series: 0, created: 0, skipped: 0, alreadyHandled: 0 };

    for (const series of await this.seriesRepo.listActive()) {
      const type = await this.typeRepo.getById(series.resourceTypeId);
      if (!type || !type.active) continue;
      result.series += 1;

      const dates = listSeriesOccurrenceDates({
        weekday: series.weekday,
        startMinutes: timeLabelToMinutes(series.startTimeLocal),
        horizonDays: type.maxAdvanceDays,
        timeZone: this.timezone,
        now,
      });

      for (const date of dates) {
        if (await this.seriesRepo.occurrenceExists(series.id, date)) {
          result.alreadyHandled += 1;
          continue;
        }
        if (await this.seriesRepo.hasSkip(series.id, date)) {
          result.alreadyHandled += 1;
          continue;
        }

        try {
          await this.reservationService.create({
            typeCode: type.code,
            date,
            slots: this.slotLabels(type, series.startTimeLocal, series.durationMinutes),
            organizerId: series.organizerId,
            admin: { adminUserId: series.createdByAdminId },
            seriesId: series.id,
            actorId: series.createdByAdminId,
            now,
          });
          result.created += 1;
        } catch (error) {
          if (error instanceof DuplicateSeriesOccurrenceError) {
            result.alreadyHandled += 1;
            continue;
          }
          const reason = skipReasonFor(error);
          if (!reason) throw error;
          await this.recordSkip(series, type, date, reason);
          result.skipped += 1;
        }
      }
    }

    return result;
  }

  /**
   * Skip + notify exactly once: the marker insert and the outbox event
   * commit atomically, and the unique (seriesId, localDate) means a
   * concurrent or later pass records nothing and notifies nobody again.
   */
  private async recordSkip(
    series: SeriesRecord,
    type: ResourceType,
    localDate: string,
    reason: string,
  ): Promise<void> {
    await this.uow.execute(async (tx) => {
      const recorded = await this.seriesRepo.tryRecordSkip(tx, series.id, localDate, reason);
      if (!recorded) return;
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: series.id,
        eventType: 'reservation_series.occurrence_skipped',
        data: {
          organizerId: series.organizerId,
          localDate,
          reason,
          typeName: type.name,
          startTimeLocal: series.startTimeLocal,
          durationMinutes: series.durationMinutes,
        },
        actorId: series.createdByAdminId,
      });
    });
  }

  private slotLabels(type: ResourceType, startTime: string, durationMinutes: number): string[] {
    if (durationMinutes <= 0 || durationMinutes % type.slotDurationMinutes !== 0) {
      throw new InvalidSlotSelectionError(
        `durationMinutes must be a positive multiple of ${type.slotDurationMinutes}`,
      );
    }
    const startMinutes = timeLabelToMinutes(startTime);
    const count = durationMinutes / type.slotDurationMinutes;
    return Array.from({ length: count }, (_, i) =>
      minutesToTimeLabel(startMinutes + i * type.slotDurationMinutes),
    );
  }
}

function skipReasonFor(error: unknown): string | null {
  if (error instanceof SlotUnavailableError) return 'slot_unavailable';
  if (error instanceof MaxReservationsExceededError) return 'daily_limit';
  if (error instanceof InactiveMembershipError) return 'membership_inactive';
  return null;
}
