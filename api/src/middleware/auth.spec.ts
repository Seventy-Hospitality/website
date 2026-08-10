import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { NotAuthorizedError, SessionExpiredError } from '@/lib/contexts/identity';

const { mockSessionService, mockMembershipChecker, containerStub } = vi.hoisted(() => {
  const mockSessionService = { validateAccessToken: vi.fn(), refresh: vi.fn() };
  const mockMembershipChecker = { hasActiveMembership: vi.fn() };

  return {
    mockSessionService,
    mockMembershipChecker,
    // Everything src/routes/* pulls from the composition root; the policy
    // tests never call into it, the "every route declares a policy" test only
    // needs the modules to import.
    containerStub: {
      sessionService: mockSessionService,
      membershipChecker: mockMembershipChecker,
      authenticationService: {},
      accountLinkingService: {},
      memberService: {},
      membershipService: {},
      memberRepo: {},
      planRepo: {},
      userRepo: {},
      reservationService: {},
      resourceRepo: {},
      resourceTypeRepo: {},
      outboxDispatcher: {},
      clubEventService: {},
      mediaService: {},
      stripeGateway: {},
      VENUE_TIMEZONE: 'America/New_York',
    },
  };
});

vi.mock('@/lib/container', () => containerStub);
vi.mock('@/lib/db', () => ({ db: {} }));

import { assertRoutePolicy, authHook, type Policy } from './auth';
import { buildTestApp } from '@/src/test/app';
import { adminRoutes } from '@/src/routes/admin';
import { authRoutes } from '@/src/routes/auth';
import { bookingRoutes } from '@/src/routes/bookings';
import { cronRoutes } from '@/src/routes/cron';
import { eventRoutes } from '@/src/routes/events';
import { mediaRoutes } from '@/src/routes/media';
import { meRoutes } from '@/src/routes/me';
import { memberRoutes } from '@/src/routes/members';
import { reservationRoutes } from '@/src/routes/reservations';
import { stripeRoutes } from '@/src/routes/stripe';
import { uploadAssetRoutes } from '@/src/routes/uploads';
import { webhookRoutes } from '@/src/routes/webhooks';

function principal(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'usr_1',
    sessionId: 'ses_1',
    email: 'alice@example.com',
    emailVerified: true,
    staffRole: null,
    memberId: null,
    client: 'member_mobile',
    ...overrides,
  };
}

/** One route per rung of the ladder, echoing back whatever principal survived. */
async function ladderRoutes(app: FastifyInstance) {
  const policies: Policy[] = [
    'public',
    'authenticated',
    'member',
    'active-member',
    'staff',
    'admin',
    'cron',
    'webhook',
  ];

  for (const policy of policies) {
    app.get(`/${policy}`, { config: { policy } }, async (req) => ({
      policy,
      principal: req.principal ?? null,
    }));
  }
}

describe('route policy boot assertion', () => {
  it('refuses a route that declares no policy', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRoute', assertRoutePolicy);

    // Omitting `config` entirely still compiles (Fastify's options object is
    // optional), which is exactly why the boot assertion exists.
    expect(() => {
      app.get('/forgotten', async () => ({ ok: true }));
    }).toThrow(/declares no auth policy/);

    await app.close();
  });

  it('fails the boot when a plugin registers an undeclared route', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRoute', assertRoutePolicy);
    app.register(async (scope) => {
      scope.get('/forgotten', async () => ({ ok: true }));
    });

    await expect(app.ready()).rejects.toThrow(/declares no auth policy/);
    await app.close();
  });

  it('boots when every route declares one', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRoute', assertRoutePolicy);
    app.get('/declared', { config: { policy: 'public' } }, async () => ({ ok: true }));

    await expect(app.ready()).resolves.toBeTruthy();
    await app.close();
  });

  it('treats @fastify/static bundle routes as public without a declaration', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRoute', assertRoutePolicy);
    app.addHook('preHandler', authHook);
    app.get('/index.html', {
      // The shape @fastify/static stamps on the routes it generates.
      config: { file: '/index.html', rootPath: '/srv/public' } as never,
    }, async () => ({ ok: true }));

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('holds for every route the API registers', async () => {
    const app = await buildTestApp(
      { routes: authRoutes, prefix: '/api/auth' },
      { routes: memberRoutes, prefix: '/api/members' },
      { routes: stripeRoutes, prefix: '/api/stripe' },
      { routes: webhookRoutes, prefix: '/api/webhooks' },
      { routes: cronRoutes, prefix: '/api/cron' },
      { routes: bookingRoutes, prefix: '/api' },
      { routes: reservationRoutes, prefix: '/api' },
      { routes: eventRoutes, prefix: '/api/events' },
      { routes: mediaRoutes, prefix: '/api/media' },
      { routes: meRoutes, prefix: '/api/me' },
      { routes: adminRoutes, prefix: '/api/admin' },
      { routes: uploadAssetRoutes, prefix: '/uploads' },
    );

    expect(app.printRoutes()).toContain('api');
    await app.close();
  });
});

describe('policy enforcement', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.AUTH_DISABLED;
    process.env.CRON_SECRET = 'cron-secret';
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockMembershipChecker.hasActiveMembership.mockResolvedValue(true);
    app = await buildTestApp({ routes: ladderRoutes });
  });

  afterEach(() => app.close());

  function callAs(policy: Policy, overrides?: Record<string, unknown>) {
    if (overrides) mockSessionService.validateAccessToken.mockResolvedValue(principal(overrides));
    return app.inject({
      method: 'GET',
      url: `/${policy}`,
      ...(overrides ? { headers: { authorization: 'Bearer access_jwt' } } : {}),
    });
  }

  it('lets anyone through a public route', async () => {
    const res = await callAs('public');
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toBeNull();
  });

  it('lets webhooks through unauthenticated (the route verifies the signature)', async () => {
    const res = await callAs('webhook');
    expect(res.statusCode).toBe(200);
  });

  it('rejects unauthenticated callers on every session-backed policy', async () => {
    for (const policy of ['authenticated', 'member', 'active-member', 'staff', 'admin'] as Policy[]) {
      const res = await callAs(policy);
      expect(res.statusCode, policy).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('attaches the principal on an authenticated route', async () => {
    const res = await callAs('authenticated', {});
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toMatchObject({ userId: 'usr_1', memberId: null });
  });

  it('refuses member routes to an account without a club profile', async () => {
    const res = await callAs('member', { memberId: null });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PROFILE_REQUIRED');
  });

  it('allows member routes once a club profile exists', async () => {
    const res = await callAs('member', { memberId: 'mem_1' });
    expect(res.statusCode).toBe(200);
    expect(mockMembershipChecker.hasActiveMembership).not.toHaveBeenCalled();
  });

  it('gates active-member routes on the membership status', async () => {
    mockMembershipChecker.hasActiveMembership.mockResolvedValue(false);
    const denied = await callAs('active-member', { memberId: 'mem_1' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('INACTIVE_MEMBERSHIP');
    expect(mockMembershipChecker.hasActiveMembership).toHaveBeenCalledWith('mem_1');

    mockMembershipChecker.hasActiveMembership.mockResolvedValue(true);
    const allowed = await callAs('active-member', { memberId: 'mem_1' });
    expect(allowed.statusCode).toBe(200);
  });

  it('keeps members out of staff and admin routes', async () => {
    const staffRoute = await callAs('staff', { memberId: 'mem_1' });
    expect(staffRoute.statusCode).toBe(403);
    expect(staffRoute.json().error.code).toBe('FORBIDDEN');

    const adminRoute = await callAs('admin', { memberId: 'mem_1' });
    expect(adminRoute.statusCode).toBe(403);
  });

  it('separates staff from admin', async () => {
    const staffOnStaff = await callAs('staff', { staffRole: 'staff' });
    expect(staffOnStaff.statusCode).toBe(200);

    const staffOnAdmin = await callAs('admin', { staffRole: 'staff' });
    expect(staffOnAdmin.statusCode).toBe(403);

    const adminOnAdmin = await callAs('admin', { staffRole: 'admin' });
    expect(adminOnAdmin.statusCode).toBe(200);
  });

  it('403s a suspended account rather than 401', async () => {
    mockSessionService.validateAccessToken.mockRejectedValue(new NotAuthorizedError());
    const res = await app.inject({
      method: 'GET',
      url: '/authenticated',
      headers: { authorization: 'Bearer access_jwt' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('requires the cron secret, and never a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/cron' })).statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'GET',
      url: '/cron',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      method: 'GET',
      url: '/cron',
      headers: { authorization: 'Bearer cron-secret' },
    });
    expect(right.statusCode).toBe(200);
    expect(mockSessionService.validateAccessToken).not.toHaveBeenCalled();
  });

  it('refuses cron when no secret is configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await app.inject({
      method: 'GET',
      url: '/cron',
      headers: { authorization: 'Bearer undefined' },
    });
    expect(res.statusCode).toBe(401);
  });

  describe('AUTH_DISABLED dev bypass', () => {
    beforeEach(() => {
      process.env.AUTH_DISABLED = 'true';
    });

    afterEach(() => {
      delete process.env.AUTH_DISABLED;
    });

    it('injects a principal that satisfies every session-backed policy', async () => {
      for (const policy of ['authenticated', 'member', 'active-member', 'staff', 'admin'] as Policy[]) {
        const res = await app.inject({ method: 'GET', url: `/${policy}` });
        expect(res.statusCode, policy).toBe(200);
        expect(res.json().principal).toMatchObject({ staffRole: 'admin', memberId: 'dev_member' });
      }
      expect(mockSessionService.validateAccessToken).not.toHaveBeenCalled();
    });

    it('does not hand out the cron secret', async () => {
      const res = await app.inject({ method: 'GET', url: '/cron' });
      expect(res.statusCode).toBe(401);
    });
  });
});
