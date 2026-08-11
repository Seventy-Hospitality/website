import { SeriesService } from './series.service';
import {
  DuplicateSeriesOccurrenceError,
  InactiveMembershipError,
  InvalidSlotSelectionError,
  MaxReservationsExceededError,
  OutsideOperatingHoursError,
  ResourceTypeNotFoundError,
  SeriesInactiveError,
  SeriesNotFoundError,
  SlotUnavailableError,
} from '../domain';
import type { UnitOfWork } from '@/lib/kernel';

const TZ = 'America/New_York';
// Tue 2026-09-01, 12:00 New York.
const NOW = new Date('2026-09-01T16:00:00.000Z');

function fixtureType(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rt_badminton',
    code: 'badminton_court',
    name: 'Badminton Court',
    slotDurationMinutes: 30,
    opStartMinutes: 8 * 60,
    opEndMinutes: 22 * 60,
    hourlyRateCents: 2000,
    maxAdvanceDays: 14,
    maxReservationsPerMemberPerDay: 2,
    cancellationDeadlineMinutes: 60,
    minTier: 'member',
    active: true,
    displayOrder: 0,
    ...overrides,
  };
}

function fixtureSeries(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ser_1',
    organizerId: 'mem_1',
    resourceTypeId: 'rt_badminton',
    weekday: 4, // Thursday
    startTimeLocal: '18:00',
    durationMinutes: 60,
    active: true,
    createdByAdminId: 'adm_1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function build() {
  const seriesRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => ({
      ...fixtureSeries(input),
      resourceType: { id: 'rt_badminton', code: 'badminton_court', name: 'Badminton Court' },
      organizer: { id: 'mem_1', firstName: 'Alice', lastName: 'Chen', memberNumber: 'A12345' },
    })),
    getById: vi.fn(async (): Promise<ReturnType<typeof fixtureSeries> | null> => fixtureSeries()),
    list: vi.fn(async () => []),
    listActive: vi.fn(async () => [fixtureSeries()]),
    deactivate: vi.fn(async () => true),
    occurrenceExists: vi.fn(async (_seriesId: string, _localDate: string) => false),
    hasSkip: vi.fn(async (_seriesId: string, _localDate: string) => false),
    tryRecordSkip: vi.fn(async () => true),
    listFutureActiveOccurrences: vi.fn(
      async (): Promise<Array<{ id: string; startsAt: Date; status: string }>> => [],
    ),
  };
  const typeRepo = {
    getByCode: vi.fn(async (): Promise<ReturnType<typeof fixtureType> | null> => fixtureType()),
    getById: vi.fn(async (): Promise<ReturnType<typeof fixtureType> | null> => fixtureType()),
  };
  const reservationRepo = {
    filterExistingMemberIds: vi.fn(async (ids: string[]) => new Set(ids)),
  };
  const reservationService = {
    create: vi.fn(async () => ({ reservation: { id: 'rsv_new' }, clientSecret: null, holdExpiresAt: null, totalCents: 0 })),
    cancel: vi.fn(async () => ({ refundCents: 0 })),
  };
  const audit = { append: vi.fn(async () => ({ id: 'evt', seq: 1 })) };
  const uow = { execute: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) } as unknown as UnitOfWork;

  const service = new SeriesService(
    seriesRepo as never,
    typeRepo as never,
    reservationRepo as never,
    reservationService as never,
    audit,
    uow,
    TZ,
  );

  return { service, seriesRepo, typeRepo, reservationRepo, reservationService, audit };
}

describe('SeriesService.create (admin-only surface)', () => {
  it('creates a series on the slot grid and appends the audit event', async () => {
    const { service, seriesRepo, audit } = build();

    const series = await service.create({
      organizerId: 'mem_1',
      typeCode: 'badminton_court',
      weekday: 4,
      startTime: '18:00',
      durationMinutes: 60,
      adminUserId: 'adm_1',
    });

    expect(seriesRepo.create).toHaveBeenCalledWith({
      organizerId: 'mem_1',
      resourceTypeId: 'rt_badminton',
      weekday: 4,
      startTimeLocal: '18:00',
      durationMinutes: 60,
      createdByAdminId: 'adm_1',
    });
    expect(series.id).toBe('ser_1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'reservation_series.created', actorId: 'adm_1' }),
    );
  });

  it('rejects an unknown type, off-grid times, and hours outside operation', async () => {
    const { service, typeRepo } = build();
    const base = {
      organizerId: 'mem_1',
      typeCode: 'badminton_court',
      weekday: 4,
      startTime: '18:00',
      durationMinutes: 60,
      adminUserId: 'adm_1',
    };

    typeRepo.getByCode.mockResolvedValueOnce(null);
    await expect(service.create(base)).rejects.toThrow(ResourceTypeNotFoundError);

    await expect(service.create({ ...base, startTime: '18:15' })).rejects.toThrow(InvalidSlotSelectionError);
    await expect(service.create({ ...base, durationMinutes: 45 })).rejects.toThrow(InvalidSlotSelectionError);
    await expect(service.create({ ...base, startTime: '21:30', durationMinutes: 60 })).rejects.toThrow(
      OutsideOperatingHoursError,
    );
    await expect(service.create({ ...base, weekday: 7 })).rejects.toThrow(InvalidSlotSelectionError);
  });
});

describe('SeriesService.cancel', () => {
  it('deactivates the series and cancels its future occurrences in full', async () => {
    const { service, seriesRepo, reservationService, audit } = build();
    seriesRepo.listFutureActiveOccurrences.mockResolvedValue([
      { id: 'rsv_a', startsAt: new Date('2026-09-03T22:00:00Z'), status: 'confirmed' },
      { id: 'rsv_b', startsAt: new Date('2026-09-10T22:00:00Z'), status: 'confirmed' },
    ]);

    const result = await service.cancel('ser_1', 'adm_1', NOW);

    expect(result).toEqual({ cancelled: true, occurrencesCancelled: 2 });
    expect(reservationService.cancel).toHaveBeenCalledWith('rsv_a', {
      fullRefund: true,
      actorId: 'adm_1',
      now: NOW,
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'reservation_series.cancelled' }),
    );
  });

  it('is idempotent: cancelling an inactive series appends nothing new', async () => {
    const { service, seriesRepo, audit } = build();
    seriesRepo.deactivate.mockResolvedValue(false);

    const result = await service.cancel('ser_1', 'adm_1', NOW);

    expect(result.cancelled).toBe(false);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('404s an unknown series', async () => {
    const { service, seriesRepo } = build();
    seriesRepo.getById.mockResolvedValue(null);
    await expect(service.cancel('ser_missing', 'adm_1')).rejects.toThrow(SeriesNotFoundError);
  });
});

describe('SeriesService.materializeDue', () => {
  it('creates comp occurrences for every horizon date not yet handled', async () => {
    const { service, reservationService } = build();

    const result = await service.materializeDue(NOW);

    // Thursdays inside 14 days from Tue 2026-09-01: 09-03 and 09-10.
    expect(reservationService.create).toHaveBeenCalledTimes(2);
    expect(reservationService.create).toHaveBeenCalledWith({
      typeCode: 'badminton_court',
      date: '2026-09-03',
      slots: ['18:00', '18:30'],
      organizerId: 'mem_1',
      admin: { adminUserId: 'adm_1' },
      seriesId: 'ser_1',
      actorId: 'adm_1',
      now: NOW,
    });
    expect(result).toEqual({ series: 1, created: 2, skipped: 0, alreadyHandled: 0 });
  });

  it('is idempotent: existing occurrences and recorded skips are not retried', async () => {
    const { service, seriesRepo, reservationService } = build();
    seriesRepo.occurrenceExists.mockImplementation(async (_id: string, date: string) => date === '2026-09-03');
    seriesRepo.hasSkip.mockImplementation(async (_id: string, date: string) => date === '2026-09-10');

    const result = await service.materializeDue(NOW);

    expect(reservationService.create).not.toHaveBeenCalled();
    expect(result).toEqual({ series: 1, created: 0, skipped: 0, alreadyHandled: 2 });
  });

  it('a collision records the skip AND the notify event atomically, never shifting the slot', async () => {
    const { service, seriesRepo, reservationService, audit } = build();
    reservationService.create.mockRejectedValueOnce(new SlotUnavailableError());

    const result = await service.materializeDue(NOW);

    expect(seriesRepo.tryRecordSkip).toHaveBeenCalledWith({}, 'ser_1', '2026-09-03', 'slot_unavailable');
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'reservation_series.occurrence_skipped',
        streamId: 'ser_1',
        data: expect.objectContaining({
          organizerId: 'mem_1',
          localDate: '2026-09-03',
          reason: 'slot_unavailable',
          typeName: 'Badminton Court',
        }),
      }),
    );
    // The second Thursday still materialized.
    expect(result).toEqual({ series: 1, created: 1, skipped: 1, alreadyHandled: 0 });
  });

  it('a skip already recorded by a racing pass notifies nobody again', async () => {
    const { service, seriesRepo, reservationService, audit } = build();
    reservationService.create.mockRejectedValueOnce(new SlotUnavailableError());
    seriesRepo.tryRecordSkip.mockResolvedValue(false);

    await service.materializeDue(NOW);

    expect(audit.append).not.toHaveBeenCalled();
  });

  it('maps daily-limit and lapsed-membership failures to their skip reasons', async () => {
    const { service, seriesRepo, reservationService } = build();
    reservationService.create
      .mockRejectedValueOnce(new MaxReservationsExceededError(2))
      .mockRejectedValueOnce(new InactiveMembershipError());

    const result = await service.materializeDue(NOW);

    expect(seriesRepo.tryRecordSkip).toHaveBeenCalledWith({}, 'ser_1', '2026-09-03', 'daily_limit');
    expect(seriesRepo.tryRecordSkip).toHaveBeenCalledWith({}, 'ser_1', '2026-09-10', 'membership_inactive');
    expect(result.skipped).toBe(2);
  });

  it('a concurrent materializer winning the unique race counts as already handled', async () => {
    const { service, reservationService } = build();
    reservationService.create.mockRejectedValueOnce(new DuplicateSeriesOccurrenceError('ser_1', '2026-09-03'));

    const result = await service.materializeDue(NOW);

    expect(result).toEqual({ series: 1, created: 1, skipped: 0, alreadyHandled: 1 });
  });

  it('a series cancelled mid-pass (insert-time active re-check) stops materializing, records no skip', async () => {
    const { service, seriesRepo, reservationService, audit } = build();
    // The repository's in-transaction guard fired: an admin cancelled the
    // series after this pass's listActive snapshot.
    reservationService.create.mockRejectedValue(new SeriesInactiveError('ser_1'));

    const result = await service.materializeDue(NOW);

    expect(reservationService.create).toHaveBeenCalledTimes(1); // no second date tried
    expect(seriesRepo.tryRecordSkip).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled(); // the organizer is not notified of anything
    expect(result).toEqual({ series: 1, created: 0, skipped: 0, alreadyHandled: 1 });
  });

  it('an unexpected error propagates (cron 500s and retries) instead of being eaten as a skip', async () => {
    const { service, reservationService } = build();
    reservationService.create.mockRejectedValueOnce(new Error('db down'));

    await expect(service.materializeDue(NOW)).rejects.toThrow('db down');
  });

  it('ignores inactive series and inactive types', async () => {
    const { service, seriesRepo, typeRepo, reservationService } = build();
    seriesRepo.listActive.mockResolvedValue([fixtureSeries()]);
    typeRepo.getById.mockResolvedValue(fixtureType({ active: false }));

    const result = await service.materializeDue(NOW);

    expect(reservationService.create).not.toHaveBeenCalled();
    expect(result.series).toBe(0);
  });
});
