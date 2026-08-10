import type { FastifyInstance } from 'fastify';
import { LinkRejectedError, SessionExpiredError } from '@/lib/contexts/identity';
import { MemberNotFoundError } from '@/lib/contexts/members';

const {
  mockAccountLinkingService,
  mockBookingService,
  mockClubEventService,
  mockMemberRepo,
  mockMemberService,
  mockMembershipService,
  mockMembershipChecker,
  mockPlanRepo,
  mockSessionService,
} = vi.hoisted(() => ({
  mockAccountLinkingService: {
    listCredentials: vi.fn(),
    linkProvider: vi.fn(),
    unlinkProvider: vi.fn(),
  },
  mockBookingService: {
    getMyBookings: vi.fn().mockResolvedValue([]),
    listAllCourts: vi.fn().mockResolvedValue([]),
    listAllShowers: vi.fn().mockResolvedValue([]),
    bookCourt: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  },
  mockClubEventService: { list: vi.fn().mockResolvedValue([]) },
  mockMemberRepo: { setStripeCustomerId: vi.fn().mockResolvedValue(undefined) },
  mockMemberService: { getById: vi.fn() },
  mockMembershipService: {
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
  },
  mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
  mockPlanRepo: { list: vi.fn().mockResolvedValue([]) },
  mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
}));

vi.mock('@/lib/container', () => ({
  accountLinkingService: mockAccountLinkingService,
  bookingService: mockBookingService,
  clubEventService: mockClubEventService,
  memberRepo: mockMemberRepo,
  memberService: mockMemberService,
  membershipService: mockMembershipService,
  membershipChecker: mockMembershipChecker,
  planRepo: mockPlanRepo,
  sessionService: mockSessionService,
}));

import { buildTestApp } from '@/src/test/app';
import { meRoutes } from './me';

function fixtureMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem_1',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'Chen',
    phone: null,
    stripeCustomerId: 'cus_1',
    membership: null,
    ...overrides,
  };
}

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

const AUTH = { authorization: 'Bearer access_jwt' } as const;

describe('me routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockMembershipChecker.hasActiveMembership.mockResolvedValue(true);
    mockBookingService.getMyBookings.mockResolvedValue([]);
    mockBookingService.listAllCourts.mockResolvedValue([]);
    mockBookingService.listAllShowers.mockResolvedValue([]);
    mockClubEventService.list.mockResolvedValue([]);
    mockPlanRepo.list.mockResolvedValue([]);
    app = await buildTestApp({ routes: meRoutes, prefix: '/api/me' });
  });

  afterEach(() => app.close());

  describe('profile', () => {
    it('resolves the member from the principal, never from the email', async () => {
      signedInAs();
      mockMemberService.getById.mockResolvedValue(fixtureMember());

      const res = await app.inject({ method: 'GET', url: '/api/me/profile', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockMemberService.getById).toHaveBeenCalledWith('mem_1');
      expect(res.json().data.member).toMatchObject({ id: 'mem_1', email: 'alice@example.com' });
    });

    it('403s an account with no club profile before the handler runs', async () => {
      signedInAs({ memberId: null });

      const res = await app.inject({ method: 'GET', url: '/api/me/profile', headers: AUTH });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PROFILE_REQUIRED');
      expect(mockMemberService.getById).not.toHaveBeenCalled();
    });

    it('404s when the profile disappeared between the principal read and the handler', async () => {
      signedInAs();
      mockMemberService.getById.mockRejectedValue(new MemberNotFoundError('mem_1'));

      const res = await app.inject({ method: 'GET', url: '/api/me/profile', headers: AUTH });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('bookings', () => {
    it('lists the principal member bookings', async () => {
      signedInAs();

      const res = await app.inject({ method: 'GET', url: '/api/me/bookings', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockBookingService.getMyBookings).toHaveBeenCalledWith('mem_1');
    });

    it('requires an active membership to book', async () => {
      signedInAs();
      mockMembershipChecker.hasActiveMembership.mockResolvedValue(false);

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/bookings',
        headers: AUTH,
        payload: { facilityType: 'court', facilityId: 'crt_1', date: '2026-09-01', startTime: '18:00' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INACTIVE_MEMBERSHIP');
      expect(mockBookingService.bookCourt).not.toHaveBeenCalled();
    });

    it('books for the principal member', async () => {
      signedInAs();
      mockBookingService.bookCourt.mockResolvedValue({
        id: 'bk_1',
        facilityType: 'court',
        facilityId: 'crt_1',
        date: new Date('2026-09-01T00:00:00Z'),
        startTime: '18:00',
        endTime: '19:00',
        status: 'confirmed',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/bookings',
        headers: AUTH,
        payload: { facilityType: 'court', facilityId: 'crt_1', date: '2026-09-01', startTime: '18:00' },
      });

      expect(res.statusCode).toBe(201);
      expect(mockBookingService.bookCourt).toHaveBeenCalledWith('crt_1', '2026-09-01', '18:00', 'mem_1');
    });

    it('lets a lapsed member cancel their own booking', async () => {
      signedInAs();
      mockMembershipChecker.hasActiveMembership.mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/me/bookings/bk_1', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockBookingService.cancel).toHaveBeenCalledWith('bk_1', 'mem_1');
    });
  });

  describe('billing', () => {
    it('derives the checkout member from the principal', async () => {
      signedInAs();
      mockMemberService.getById.mockResolvedValue(fixtureMember({ stripeCustomerId: null }));
      mockMembershipService.createCheckoutSession.mockResolvedValue({
        url: 'https://stripe.test/checkout',
        newStripeCustomerId: 'cus_new',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/checkout',
        headers: AUTH,
        payload: { planId: 'plan_1', memberId: 'mem_someone_else' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ url: 'https://stripe.test/checkout' });
      expect(mockMembershipService.createCheckoutSession).toHaveBeenCalledWith(
        'mem_1',
        'plan_1',
        'alice@example.com',
        'Alice Chen',
        null,
      );
      expect(mockMemberRepo.setStripeCustomerId).toHaveBeenCalledWith('mem_1', 'cus_new');
    });

    it('derives the billing portal member from the principal', async () => {
      signedInAs();
      mockMemberService.getById.mockResolvedValue(fixtureMember());
      mockMembershipService.createPortalSession.mockResolvedValue('https://stripe.test/portal');

      const res = await app.inject({ method: 'POST', url: '/api/me/billing-portal', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.createPortalSession).toHaveBeenCalledWith('mem_1', 'cus_1');
    });
  });

  describe('sign-in methods', () => {
    it('lists linked providers and whether a password exists', async () => {
      signedInAs({ memberId: null });
      mockAccountLinkingService.listCredentials.mockResolvedValue({
        hasPassword: true,
        identities: [
          {
            provider: 'google',
            email: 'alice@example.com',
            isPrivateRelay: false,
            linkedAt: new Date('2026-08-01T00:00:00Z'),
            lastUsedAt: null,
          },
        ],
      });

      const res = await app.inject({ method: 'GET', url: '/api/me/auth-identities', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockAccountLinkingService.listCredentials).toHaveBeenCalledWith('usr_1');
      expect(res.json().data).toEqual({
        hasPassword: true,
        identities: [
          {
            provider: 'google',
            email: 'alice@example.com',
            isPrivateRelay: false,
            linkedAt: '2026-08-01T00:00:00.000Z',
            lastUsedAt: null,
          },
        ],
      });
    });

    it('links a provider to the signed-in account', async () => {
      signedInAs();
      mockAccountLinkingService.linkProvider.mockResolvedValue({ linked: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/auth-identities/google',
        headers: AUTH,
        payload: { idToken: 'id_token', nonce: 'raw_nonce' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ provider: 'google', linked: true });
      expect(mockAccountLinkingService.linkProvider).toHaveBeenCalledWith(
        'usr_1',
        'google',
        { idToken: 'id_token', nonce: 'raw_nonce' },
        true, // principal.emailVerified — gates the pre-hijack link defense
      );
    });

    it('rejects an unknown provider', async () => {
      signedInAs();

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/auth-identities/facebook',
        headers: AUTH,
        payload: { idToken: 'id_token', nonce: 'raw_nonce' },
      });

      expect(res.statusCode).toBe(404);
      expect(mockAccountLinkingService.linkProvider).not.toHaveBeenCalled();
    });

    it('409s when the provider account belongs to somebody else', async () => {
      signedInAs();
      mockAccountLinkingService.linkProvider.mockRejectedValue(
        new LinkRejectedError('linked_to_other_account'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/auth-identities/apple',
        headers: AUTH,
        payload: { idToken: 'id_token', nonce: 'raw_nonce' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('LINK_REJECTED');
    });

    it('unlinks a provider', async () => {
      signedInAs();
      mockAccountLinkingService.unlinkProvider.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/me/auth-identities/google',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(mockAccountLinkingService.unlinkProvider).toHaveBeenCalledWith('usr_1', 'google');
    });

    it('refuses to remove the last credential', async () => {
      signedInAs();
      mockAccountLinkingService.unlinkProvider.mockRejectedValue(new LinkRejectedError('last_credential'));

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/me/auth-identities/google',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/no way to sign in/);
    });

    it('is reachable without a club profile', async () => {
      signedInAs({ memberId: null });
      mockAccountLinkingService.listCredentials.mockResolvedValue({ hasPassword: true, identities: [] });

      const res = await app.inject({ method: 'GET', url: '/api/me/auth-identities', headers: AUTH });

      expect(res.statusCode).toBe(200);
    });

    it('requires a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/me/auth-identities' });
      expect(res.statusCode).toBe(401);
    });
  });
});
