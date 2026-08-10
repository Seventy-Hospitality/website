import { ClubEventService } from './event.service';
import type { ClubEventRepository, ClubEventRow } from '../infrastructure';
import { ClubEventCourtConflictError } from '../domain';
import type { ResourceClaimPort } from '@/lib/contexts/bookings';
import { EventClaimConflictError } from '@/lib/contexts/bookings';
import type { UnitOfWork } from '@/lib/kernel';

function mockEventRepo(): ClubEventRepository {
  return {
    list: vi.fn().mockResolvedValue([]),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as ClubEventRepository;
}

function mockClaimPort(): ResourceClaimPort {
  return {
    getResourcesByIds: vi.fn().mockResolvedValue([]),
    listResourcesForEvents: vi.fn().mockResolvedValue(new Map()),
    listEventConflicts: vi.fn().mockResolvedValue([]),
    cancelReservations: vi.fn().mockResolvedValue(undefined),
    syncEventClaims: vi.fn().mockResolvedValue(undefined),
  };
}

function mockMediaStore() {
  return {
    isManagedAsset: vi.fn().mockReturnValue(true),
    attachManagedAssetToOwner: vi.fn(),
    deleteManagedAsset: vi.fn(),
  };
}

function mockUow(): UnitOfWork {
  return {
    execute: vi.fn(async (fn: any) => fn({})),
  } as unknown as UnitOfWork;
}

function makeEventRow(overrides: Partial<ClubEventRow> = {}): ClubEventRow {
  return {
    id: 'evt_1',
    title: 'Sunday Open Play',
    imageUrl: '/uploads/event-images/original.png',
    details: 'Round robin',
    startsAt: new Date('2026-04-05T14:00:00.000Z'),
    endsAt: new Date('2026-04-05T22:00:00.000Z'),
    timezone: 'America/New_York',
    active: true,
    createdAt: new Date('2026-04-01T12:00:00.000Z'),
    updatedAt: new Date('2026-04-01T12:00:00.000Z'),
    ...overrides,
  };
}

function buildService(overrides: {
  repo?: ClubEventRepository;
  claimPort?: ResourceClaimPort;
  mediaStore?: ReturnType<typeof mockMediaStore>;
  uow?: UnitOfWork;
} = {}) {
  const repo = overrides.repo ?? mockEventRepo();
  const claimPort = overrides.claimPort ?? mockClaimPort();
  const mediaStore = overrides.mediaStore ?? mockMediaStore();
  const uow = overrides.uow ?? mockUow();
  return { service: new ClubEventService(repo, claimPort, mediaStore, uow), repo, claimPort, mediaStore, uow };
}

describe('ClubEventService', () => {
  it('attaches uploaded images when creating an event', async () => {
    const repo = mockEventRepo();
    const mediaStore = mockMediaStore();
    const createdEvent = makeEventRow();
    (repo.create as ReturnType<typeof vi.fn>).mockResolvedValue(createdEvent);
    const { service } = buildService({ repo, mediaStore });

    const result = await service.create({
      title: createdEvent.title,
      imageUrl: createdEvent.imageUrl,
      startsAt: createdEvent.startsAt,
      endsAt: createdEvent.endsAt,
      timezone: createdEvent.timezone,
      active: true,
    });

    expect(result).toMatchObject({ id: createdEvent.id, courts: [] });
    expect(mediaStore.attachManagedAssetToOwner).toHaveBeenCalledWith(createdEvent.imageUrl, {
      ownerType: 'club-event',
      ownerId: createdEvent.id,
    });
  });

  it('claims courts through the port inside the transaction', async () => {
    const repo = mockEventRepo();
    const claimPort = mockClaimPort();
    const createdEvent = makeEventRow();
    (repo.create as ReturnType<typeof vi.fn>).mockResolvedValue(createdEvent);
    (claimPort.getResourcesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'court-1', name: 'Court 1' },
    ]);
    const { service } = buildService({ repo, claimPort });

    const result = await service.create({
      title: createdEvent.title,
      startsAt: createdEvent.startsAt,
      endsAt: createdEvent.endsAt,
      timezone: createdEvent.timezone,
      active: true,
      courtIds: ['court-1'],
    });

    expect(claimPort.syncEventClaims).toHaveBeenCalledWith(expect.anything(), {
      eventId: createdEvent.id,
      resourceIds: ['court-1'],
      startsAt: createdEvent.startsAt,
      endsAt: createdEvent.endsAt,
      active: true,
    });
    expect(result.courts).toEqual([{ id: 'court-1', name: 'Court 1' }]);
  });

  it('surfaces reservation conflicts as a 409-shaped error with the roster', async () => {
    const repo = mockEventRepo();
    const claimPort = mockClaimPort();
    (claimPort.getResourcesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'court-1', name: 'Court 1' },
    ]);
    (claimPort.listEventConflicts as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        reservationId: 'rsv_1',
        reference: 'BK-001000',
        resourceId: 'court-1',
        resourceName: 'Court 1',
        organizerId: 'mem_1',
        organizerName: 'Alice Chen',
        organizerEmail: 'alice@example.com',
        localDate: '2026-04-05',
        startTime: '10:00',
        endTime: '11:00',
      },
    ]);
    const { service } = buildService({ repo, claimPort });

    await expect(
      service.create({
        title: 'Blocked',
        startsAt: new Date('2026-04-05T14:00:00.000Z'),
        endsAt: new Date('2026-04-05T15:00:00.000Z'),
        timezone: 'America/New_York',
        active: true,
        courtIds: ['court-1'],
      }),
    ).rejects.toMatchObject({
      name: 'ClubEventCourtConflictError',
      conflicts: [expect.objectContaining({ bookingId: 'rsv_1', courtId: 'court-1', memberName: 'Alice Chen' })],
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('cancels conflicting reservations through the port when asked to', async () => {
    const repo = mockEventRepo();
    const claimPort = mockClaimPort();
    const createdEvent = makeEventRow();
    (repo.create as ReturnType<typeof vi.fn>).mockResolvedValue(createdEvent);
    (claimPort.getResourcesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'court-1', name: 'Court 1' },
    ]);
    (claimPort.listEventConflicts as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        reservationId: 'rsv_1',
        reference: 'BK-001000',
        resourceId: 'court-1',
        resourceName: 'Court 1',
        organizerId: 'mem_1',
        organizerName: 'Alice Chen',
        organizerEmail: 'alice@example.com',
        localDate: '2026-04-05',
        startTime: '10:00',
        endTime: '11:00',
      },
    ]);
    const { service } = buildService({ repo, claimPort });

    await service.create({
      title: createdEvent.title,
      startsAt: createdEvent.startsAt,
      endsAt: createdEvent.endsAt,
      timezone: createdEvent.timezone,
      active: true,
      courtIds: ['court-1'],
      cancelConflictingBookings: true,
      actorId: 'usr_admin',
    });

    expect(claimPort.cancelReservations).toHaveBeenCalledWith(['rsv_1'], 'usr_admin');
    expect(claimPort.syncEventClaims).toHaveBeenCalled();
  });

  it('maps a lost claim race to the conflict error', async () => {
    const repo = mockEventRepo();
    const claimPort = mockClaimPort();
    const createdEvent = makeEventRow();
    (repo.create as ReturnType<typeof vi.fn>).mockResolvedValue(createdEvent);
    (claimPort.getResourcesByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'court-1', name: 'Court 1' },
    ]);
    (claimPort.syncEventClaims as ReturnType<typeof vi.fn>).mockRejectedValue(new EventClaimConflictError([]));
    const { service } = buildService({ repo, claimPort });

    await expect(
      service.create({
        title: createdEvent.title,
        startsAt: createdEvent.startsAt,
        endsAt: createdEvent.endsAt,
        timezone: createdEvent.timezone,
        active: true,
        courtIds: ['court-1'],
      }),
    ).rejects.toBeInstanceOf(ClubEventCourtConflictError);
  });

  it('attaches a replacement image and discards the previous one on update', async () => {
    const repo = mockEventRepo();
    const mediaStore = mockMediaStore();
    const existing = makeEventRow();
    const updated = makeEventRow({
      imageUrl: '/uploads/event-images/replacement.png',
      updatedAt: new Date('2026-04-02T12:00:00.000Z'),
    });
    (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    (repo.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    const { service } = buildService({ repo, mediaStore });

    const result = await service.update(existing.id, {
      imageUrl: updated.imageUrl,
    });

    expect(result).toMatchObject({ id: updated.id, imageUrl: updated.imageUrl });
    expect(mediaStore.attachManagedAssetToOwner).toHaveBeenCalledWith(updated.imageUrl, {
      ownerType: 'club-event',
      ownerId: updated.id,
    });
    expect(mediaStore.deleteManagedAsset).toHaveBeenCalledWith(existing.imageUrl);
  });

  it('does not discard the image when it is unchanged on update', async () => {
    const repo = mockEventRepo();
    const mediaStore = mockMediaStore();
    const existing = makeEventRow();
    const updated = makeEventRow({
      updatedAt: new Date('2026-04-02T12:00:00.000Z'),
    });
    (repo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    (repo.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
    const { service } = buildService({ repo, mediaStore });

    await service.update(existing.id, {
      details: 'Updated details',
    });

    expect(mediaStore.attachManagedAssetToOwner).toHaveBeenCalledWith(updated.imageUrl, {
      ownerType: 'club-event',
      ownerId: updated.id,
    });
    expect(mediaStore.deleteManagedAsset).not.toHaveBeenCalled();
  });

  it('rejects unmanaged image urls', async () => {
    const mediaStore = mockMediaStore();
    (mediaStore.isManagedAsset as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { service } = buildService({ mediaStore });

    await expect(service.create({
      title: 'Bad Image Event',
      imageUrl: 'https://example.com/image.png',
      startsAt: new Date('2026-04-05T14:00:00.000Z'),
      endsAt: new Date('2026-04-05T15:00:00.000Z'),
      timezone: 'America/New_York',
      active: true,
    })).rejects.toThrow('uploaded through the media endpoint');
  });
});
