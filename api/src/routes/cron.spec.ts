import type { FastifyInstance } from 'fastify';

const { mockMembershipService, mockMediaService, mockDb, mockMembershipChecker, mockReservationService, mockOutboxDispatcher } = vi.hoisted(() => ({
  mockMembershipService: {
    syncFromStripe: vi.fn(),
  },
  mockMediaService: {
    cleanupStaleEventImages: vi.fn().mockResolvedValue({
      deletedCount: 1,
      deletedImageUrls: ['/uploads/event-images/old.png'],
      cutoff: new Date('2026-04-03T12:00:00.000Z'),
    }),
  },
  mockDb: {
    member: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  mockMembershipChecker: {
    hasActiveMembership: vi.fn().mockResolvedValue(true),
  },
  mockReservationService: {
    expireStaleHolds: vi.fn().mockResolvedValue({ expired: 0, confirmed: 0 }),
  },
  mockOutboxDispatcher: {
    dispatch: vi.fn().mockResolvedValue({ dispatched: 0 }),
  },
}));

vi.mock('@/lib/container', () => ({
  membershipService: mockMembershipService,
  mediaService: mockMediaService,
  membershipChecker: mockMembershipChecker,
  reservationService: mockReservationService,
  outboxDispatcher: mockOutboxDispatcher,
}));

vi.mock('@/lib/db', () => ({
  db: mockDb,
}));

import { buildTestApp } from '@/src/test/app';
import { cronRoutes } from './cron';

describe('cron routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.CRON_SECRET = 'test-secret';
    app = await buildTestApp({ routes: cronRoutes });
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.member.findMany.mockResolvedValue([]);
    mockMediaService.cleanupStaleEventImages.mockResolvedValue({
      deletedCount: 1,
      deletedImageUrls: ['/uploads/event-images/old.png'],
      cutoff: new Date('2026-04-03T12:00:00.000Z'),
    });
  });

  it('sweeps expired holds behind the cron secret', async () => {
    mockReservationService.expireStaleHolds.mockResolvedValue({ expired: 2, confirmed: 1 });

    const denied = await app.inject({ method: 'POST', url: '/expire-holds' });
    expect(denied.statusCode).toBe(401);

    const response = await app.inject({
      method: 'POST',
      url: '/expire-holds',
      headers: { authorization: 'Bearer test-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ expired: 2, confirmed: 1 });
  });

  it('dispatches the outbox behind the cron secret', async () => {
    mockOutboxDispatcher.dispatch.mockResolvedValue({ dispatched: 5 });

    const denied = await app.inject({ method: 'POST', url: '/dispatch-outbox' });
    expect(denied.statusCode).toBe(401);

    const response = await app.inject({
      method: 'POST',
      url: '/dispatch-outbox',
      headers: { authorization: 'Bearer test-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dispatched: 5 });
  });

  it('rejects cleanup requests without the cron secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/cleanup-event-images',
    });

    expect(response.statusCode).toBe(401);
    expect(mockMediaService.cleanupStaleEventImages).not.toHaveBeenCalled();
  });

  it('rejects a wrong cron secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/cleanup-event-images',
      headers: { authorization: 'Bearer wrong-secret' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('runs stale event image cleanup with validated query params', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/cleanup-event-images?maxAgeHours=48&limit=25',
      headers: {
        authorization: 'Bearer test-secret',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockMediaService.cleanupStaleEventImages).toHaveBeenCalledWith({
      maxAgeHours: 48,
      limit: 25,
    });
    expect(response.json()).toEqual({
      deletedCount: 1,
      deletedImageUrls: ['/uploads/event-images/old.png'],
      cutoff: '2026-04-03T12:00:00.000Z',
    });
  });
});
