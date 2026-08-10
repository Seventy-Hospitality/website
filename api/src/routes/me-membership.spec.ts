import type { FastifyInstance } from 'fastify';
import { SessionExpiredError } from '@/lib/contexts/identity';
import { MembershipError, PlanInviteOnlyError, PlanNotFoundError } from '@/lib/contexts/memberships';

const { mockMemberRepo, mockMemberService, mockMembershipService, mockMembershipChecker, mockSessionService } =
  vi.hoisted(() => ({
    mockMemberRepo: { setStripeCustomerId: vi.fn().mockResolvedValue(undefined) },
    mockMemberService: { getById: vi.fn() },
    mockMembershipService: {
      subscribe: vi.fn(),
      confirmSubscription: vi.fn(),
      changePlan: vi.fn(),
      cancelMembership: vi.fn(),
      getOverview: vi.fn(),
    },
    mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
    mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
  }));

vi.mock('@/lib/container', () => ({
  memberRepo: mockMemberRepo,
  memberService: mockMemberService,
  membershipService: mockMembershipService,
  membershipChecker: mockMembershipChecker,
  sessionService: mockSessionService,
}));

import { buildTestApp } from '@/src/test/app';
import { meMembershipRoutes } from './me-membership';

const AUTH = { authorization: 'Bearer access_jwt' } as const;

function signedInAs(overrides: Record<string, unknown> = {}) {
  mockSessionService.validateAccessToken.mockResolvedValue({
    userId: 'usr_1',
    sessionId: 'ses_1',
    email: 'alice@example.com',
    emailVerified: true,
    staffRole: null,
    memberId: 'mem_1',
    client: 'member_mobile',
    ...overrides,
  });
}

const MEMBER = {
  id: 'mem_1',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Chen',
  stripeCustomerId: 'cus_1',
};

const OVERVIEW = {
  membership: {
    id: 'ms_1',
    status: 'active',
    currentPeriodEnd: new Date('2026-09-10T12:00:00Z'),
    cancelAtPeriodEnd: false,
    pendingPlanEffectiveAt: null,
  },
  plan: { id: 'plan_m', name: 'Monthly', amountCents: 5000, interval: 'month', tier: 'member' },
  pendingPlan: null,
};

describe('me-membership routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockMembershipChecker.hasActiveMembership.mockResolvedValue(true);
    mockMemberService.getById.mockResolvedValue(MEMBER);
    mockMembershipService.getOverview.mockResolvedValue(OVERVIEW);
    app = await buildTestApp({ routes: meMembershipRoutes, prefix: '/api/me' });
  });

  afterEach(() => app.close());

  describe('POST /membership/subscribe', () => {
    it('requires a member principal', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/membership/subscribe',
        payload: { planId: 'plan_m', termsVersion: '2026-01' },
      });
      expect(res.statusCode).toBe(401);

      signedInAs({ memberId: null });
      const noProfile = await app.inject({
        method: 'POST',
        url: '/api/me/membership/subscribe',
        headers: AUTH,
        payload: { planId: 'plan_m', termsVersion: '2026-01' },
      });
      expect(noProfile.statusCode).toBe(403);
      expect(mockMembershipService.subscribe).not.toHaveBeenCalled();
    });

    it('derives the member and user from the principal, never the body, and persists a new customer id', async () => {
      signedInAs();
      mockMembershipService.subscribe.mockResolvedValue({
        subscriptionId: 'sub_1',
        clientSecret: 'cs_secret',
        customerId: 'cus_new',
        ephemeralKeySecret: 'ek_secret',
        newStripeCustomerId: 'cus_new',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/membership/subscribe',
        headers: AUTH,
        payload: { planId: 'plan_m', termsVersion: '2026-01', memberId: 'mem_ATTACKER' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: 'mem_1', userId: 'usr_1', termsVersion: '2026-01' }),
      );
      expect(mockMemberRepo.setStripeCustomerId).toHaveBeenCalledWith('mem_1', 'cus_new');
      expect(res.json().data).toMatchObject({ subscriptionId: 'sub_1', clientSecret: 'cs_secret' });
    });

    it('validates the body', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/membership/subscribe',
        headers: AUTH,
        payload: { planId: 'plan_m' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('maps domain failures onto response codes', async () => {
      signedInAs();
      mockMembershipService.subscribe.mockRejectedValue(new PlanNotFoundError('nope'));
      const notFound = await app.inject({
        method: 'POST',
        url: '/api/me/membership/subscribe',
        headers: AUTH,
        payload: { planId: 'nope', termsVersion: '2026-01' },
      });
      expect(notFound.statusCode).toBe(404);

      mockMembershipService.subscribe.mockRejectedValue(new PlanInviteOnlyError());
      const inviteOnly = await app.inject({
        method: 'POST',
        url: '/api/me/membership/subscribe',
        headers: AUTH,
        payload: { planId: 'plan_p', termsVersion: '2026-01' },
      });
      expect(inviteOnly.statusCode).toBe(403);

      mockMembershipService.subscribe.mockRejectedValue(new MembershipError('already active'));
      const conflict = await app.inject({
        method: 'POST',
        url: '/api/me/membership/subscribe',
        headers: AUTH,
        payload: { planId: 'plan_m', termsVersion: '2026-01' },
      });
      expect(conflict.statusCode).toBe(409);
    });
  });

  describe('POST /membership/confirm', () => {
    it('reads back and activates via the principal member', async () => {
      signedInAs();
      mockMembershipService.confirmSubscription.mockResolvedValue({ ...OVERVIEW, activated: true });

      const res = await app.inject({ method: 'POST', url: '/api/me/membership/confirm', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.confirmSubscription).toHaveBeenCalledWith('mem_1');
      expect(res.json().data).toMatchObject({
        activated: true,
        membership: expect.objectContaining({ status: 'active', plan: expect.objectContaining({ id: 'plan_m' }) }),
      });
    });
  });

  describe('POST /membership/change', () => {
    it('requires an ACTIVE membership', async () => {
      signedInAs();
      mockMembershipChecker.hasActiveMembership.mockResolvedValue(false);
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/membership/change',
        headers: AUTH,
        payload: { planId: 'plan_a' },
      });
      expect(res.statusCode).toBe(403);
      expect(mockMembershipService.changePlan).not.toHaveBeenCalled();
    });

    it('changes the plan for the principal member', async () => {
      signedInAs();
      mockMembershipService.changePlan.mockResolvedValue({
        kind: 'downgrade_scheduled',
        clientSecret: null,
        pendingPlanEffectiveAt: new Date('2026-09-10T12:00:00Z'),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/membership/change',
        headers: AUTH,
        payload: { planId: 'plan_m' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.changePlan).toHaveBeenCalledWith('mem_1', 'plan_m');
      expect(res.json().data).toMatchObject({
        kind: 'downgrade_scheduled',
        pendingPlanEffectiveAt: '2026-09-10T12:00:00.000Z',
      });
    });
  });

  describe('DELETE /membership', () => {
    it('cancels at period end by default and immediately with ?now=true (member policy: past_due can cancel)', async () => {
      signedInAs();
      mockMembershipChecker.hasActiveMembership.mockResolvedValue(false); // past_due member
      mockMembershipService.cancelMembership.mockResolvedValue({
        canceledImmediately: false,
        effectiveAt: new Date('2026-09-10T12:00:00Z'),
      });

      const periodEnd = await app.inject({ method: 'DELETE', url: '/api/me/membership', headers: AUTH });
      expect(periodEnd.statusCode).toBe(200);
      expect(mockMembershipService.cancelMembership).toHaveBeenCalledWith('mem_1', { now: false });

      mockMembershipService.cancelMembership.mockResolvedValue({
        canceledImmediately: true,
        effectiveAt: new Date('2026-08-10T12:00:00Z'),
      });
      const now = await app.inject({ method: 'DELETE', url: '/api/me/membership?now=true', headers: AUTH });
      expect(now.statusCode).toBe(200);
      expect(mockMembershipService.cancelMembership).toHaveBeenLastCalledWith('mem_1', { now: true });
      expect(now.json().data.canceledImmediately).toBe(true);
    });
  });
});
