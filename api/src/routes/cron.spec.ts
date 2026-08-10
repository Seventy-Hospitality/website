import type { FastifyInstance } from 'fastify';

const {
  mockMembershipService,
  mockMediaService,
  mockDb,
  mockMembershipChecker,
  mockReservationService,
  mockOutboxDispatcher,
  mockReconciliationService,
} = vi.hoisted(() => ({
  mockMembershipService: {
    reconcileSubscriptionDrift: vi.fn().mockResolvedValue({ checked: 0, updated: 0, stale: 0, skipped: 0, orphanedLocal: 0 }),
  },
  mockReconciliationService: {
    reconcileBilling: vi.fn().mockResolvedValue({ charges: 0, invoices: 0, refunds: 0, settlementsTriggered: 0, unmatched: 0, dedupeRowsPruned: 0 }),
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
  reconciliationService: mockReconciliationService,
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

  it('runs the nightly billing reconcile behind the cron secret (GET works for URL schedulers)', async () => {
    mockReconciliationService.reconcileBilling.mockResolvedValue({
      charges: 3,
      invoices: 2,
      refunds: 1,
      settlementsTriggered: 1,
      unmatched: 0,
      dedupeRowsPruned: 10,
    });

    const denied = await app.inject({ method: 'POST', url: '/reconcile-billing' });
    expect(denied.statusCode).toBe(401);
    expect(mockReconciliationService.reconcileBilling).not.toHaveBeenCalled();

    const viaPost = await app.inject({
      method: 'POST',
      url: '/reconcile-billing',
      headers: { authorization: 'Bearer test-secret' },
    });
    expect(viaPost.statusCode).toBe(200);
    expect(viaPost.json()).toEqual(expect.objectContaining({ charges: 3, settlementsTriggered: 1 }));

    const viaGet = await app.inject({
      method: 'GET',
      url: '/reconcile-billing',
      headers: { authorization: 'Bearer test-secret' },
    });
    expect(viaGet.statusCode).toBe(200);
  });

  it('runs the account-wide subscription drift check (replaces the per-member sync loop)', async () => {
    mockMembershipService.reconcileSubscriptionDrift.mockResolvedValue({
      checked: 12,
      updated: 2,
      stale: 0,
      skipped: 1,
      orphanedLocal: 0,
    });

    const denied = await app.inject({ method: 'POST', url: '/subscription-drift' });
    expect(denied.statusCode).toBe(401);

    const response = await app.inject({
      method: 'POST',
      url: '/subscription-drift',
      headers: { authorization: 'Bearer test-secret' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ checked: 12, updated: 2 }));
  });

  it('serves no legacy per-member sync-memberships route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sync-memberships',
      headers: { authorization: 'Bearer test-secret' },
    });
    expect(response.statusCode).toBe(404);
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
