import type { FastifyInstance } from 'fastify';
import { LinkRejectedError, SessionExpiredError } from '@/lib/contexts/identity';
import { MemberNotFoundError } from '@/lib/contexts/members';

const {
  mockAccountLinkingService,
  mockReservationService,
  mockResourceRepo,
  mockResourceTypeRepo,
  mockClubEventService,
  mockHomeService,
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
  mockReservationService: {
    listForMember: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn().mockResolvedValue({ refundCents: 0 }),
    getLifetimeActivityStats: vi
      .fn()
      .mockResolvedValue({ courtsBooked: 0, badmintonMinutes: 0, tennisMinutes: 0 }),
  },
  mockResourceRepo: { getById: vi.fn() },
  mockResourceTypeRepo: { getById: vi.fn() },
  mockClubEventService: { list: vi.fn().mockResolvedValue([]) },
  mockHomeService: { getHome: vi.fn() },
  mockMemberRepo: { setStripeCustomerId: vi.fn().mockResolvedValue(undefined) },
  mockMemberService: { getById: vi.fn(), updateDisplayName: vi.fn() },
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
  reservationService: mockReservationService,
  resourceRepo: mockResourceRepo,
  resourceTypeRepo: mockResourceTypeRepo,
  clubEventService: mockClubEventService,
  homeService: mockHomeService,
  memberRepo: mockMemberRepo,
  memberService: mockMemberService,
  membershipService: mockMembershipService,
  membershipChecker: mockMembershipChecker,
  planRepo: mockPlanRepo,
  sessionService: mockSessionService,
  VENUE_TIMEZONE: 'America/New_York',
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
    memberNumber: 'A12345',
    displayName: null,
    avatarUrl: null,
    deletedAt: null,
    createdAt: new Date('2025-01-15T00:00:00Z'),
    stripeCustomerId: 'cus_1',
    membership: null,
    ...overrides,
  };
}

function fixtureHome(overrides: Record<string, unknown> = {}) {
  return {
    greeting: { firstName: 'Alice', timeOfDay: 'evening', timezone: 'America/New_York' },
    upcomingReservations: [],
    pendingInvitations: [],
    clubInvitations: [],
    spotlightEvents: [],
    quickBook: null,
    emptyStateAmenities: null,
    ...overrides,
  };
}

function fixtureReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rsv_1',
    reference: 'BK-001000',
    resourceTypeId: 'rt_badminton_court',
    resourceId: 'crt_1',
    organizerId: 'mem_1',
    clubId: null,
    seriesId: null,
    // 18:00-19:00 America/New_York on 2026-09-01
    startsAt: new Date('2026-09-01T22:00:00.000Z'),
    endsAt: new Date('2026-09-01T23:00:00.000Z'),
    localDate: '2026-09-01',
    status: 'confirmed',
    hourlyRateCentsSnapshot: 2000,
    amountPaidCents: 2000,
    createdByAdminId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    resourceType: { id: 'rt_badminton_court', code: 'badminton_court', name: 'Badminton Court' },
    resource: { id: 'crt_1', name: 'Court 1' },
    participants: [
      {
        id: 'rp_1',
        reservationId: 'rsv_1',
        memberId: 'mem_1',
        role: 'organizer',
        status: 'confirmed',
        invitedById: null,
        viaClubId: null,
        invitedAt: new Date('2026-08-01T00:00:00Z'),
        respondedAt: null,
        member: { id: 'mem_1', firstName: 'Alice', lastName: 'Chen', email: 'alice@example.com' },
      },
    ],
    payments: [],
    claim: { id: 'clm_1', status: 'active', expiresAt: null },
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
    mockReservationService.listForMember.mockResolvedValue([]);
    mockReservationService.cancel.mockResolvedValue({ refundCents: 0 });
    mockClubEventService.list.mockResolvedValue([]);
    mockHomeService.getHome.mockResolvedValue(fixtureHome());
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
      expect(res.json().data.member).toMatchObject({
        id: 'mem_1',
        email: 'alice@example.com',
        memberNumber: 'A12345',
        memberSince: '2025-01-15T00:00:00.000Z',
      });
    });

    it('serves lifetime activity stats (courts, badminton hours, tennis hours)', async () => {
      signedInAs();
      mockMemberService.getById.mockResolvedValue(fixtureMember());
      mockReservationService.getLifetimeActivityStats.mockResolvedValue({
        courtsBooked: 15,
        badmintonMinutes: 720,
        tennisMinutes: 270,
      });

      const res = await app.inject({ method: 'GET', url: '/api/me/profile', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.getLifetimeActivityStats).toHaveBeenCalledWith('mem_1');
      expect(res.json().data.stats).toEqual({
        courtsBooked: 15,
        badmintonHours: 12,
        tennisHours: 4.5,
      });
    });

    it('PATCH updates the display name for the principal member', async () => {
      signedInAs();
      mockMemberService.getById.mockResolvedValue(fixtureMember({ displayName: 'Ali' }));
      mockMemberService.updateDisplayName.mockResolvedValue({});

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/profile',
        headers: AUTH,
        payload: { displayName: 'Ali' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMemberService.updateDisplayName).toHaveBeenCalledWith('mem_1', 'Ali');
      expect(res.json().data.member.displayName).toBe('Ali');
    });

    it('PATCH rejects a body without the displayName key', async () => {
      signedInAs();
      const res = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: AUTH, payload: {} });
      expect(res.statusCode).toBe(400);
      expect(mockMemberService.updateDisplayName).not.toHaveBeenCalled();
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
    it('lists the principal member reservations in the legacy shape', async () => {
      signedInAs();
      mockReservationService.listForMember.mockResolvedValue([fixtureReservation()]);

      const res = await app.inject({ method: 'GET', url: '/api/me/bookings', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.listForMember).toHaveBeenCalledWith('mem_1', 'upcoming');
      expect(res.json().data[0]).toMatchObject({
        id: 'rsv_1',
        facilityType: 'court',
        facilityName: 'Court 1',
        date: '2026-09-01',
        startTime: '18:00',
        endTime: '19:00',
        status: 'confirmed',
      });
    });

    it('keeps the caller own email on bookings they organize', async () => {
      signedInAs();
      mockReservationService.listForMember.mockResolvedValue([fixtureReservation()]);

      const res = await app.inject({ method: 'GET', url: '/api/me/bookings', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].member.email).toBe('alice@example.com');
    });

    it('redacts the organizer email from bookings the caller merely participates in', async () => {
      // mem_2 is a guest on Alice's reservation: the organizer's email is
      // PII and must not leak through the legacy serializer.
      signedInAs({ memberId: 'mem_2' });
      mockMemberService.getById.mockResolvedValue(fixtureMember({ id: 'mem_2', email: 'guest@example.com' }));
      mockReservationService.listForMember.mockResolvedValue([fixtureReservation()]);

      const bookings = await app.inject({ method: 'GET', url: '/api/me/bookings', headers: AUTH });
      expect(bookings.statusCode).toBe(200);
      expect(bookings.json().data[0].member.email).toBeNull();
      expect(bookings.json().data[0].member.firstName).toBe('Alice');

      mockHomeService.getHome.mockResolvedValue(fixtureHome({ upcomingReservations: [fixtureReservation()] }));
      const home = await app.inject({ method: 'GET', url: '/api/me/home', headers: AUTH });
      expect(home.statusCode).toBe(200);
      expect(home.json().data.upcomingBookings[0].member.email).toBeNull();
    });

    it('lists reservations with participation status', async () => {
      signedInAs();
      mockReservationService.listForMember.mockResolvedValue([fixtureReservation()]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/me/reservations?filter=upcoming',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data[0]).toMatchObject({
        reference: 'BK-001000',
        typeCode: 'badminton_court',
        myParticipation: { role: 'organizer', status: 'confirmed' },
      });
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
      expect(mockReservationService.create).not.toHaveBeenCalled();
    });

    it('books for the principal member on the named resource', async () => {
      signedInAs();
      mockResourceRepo.getById.mockResolvedValue({ id: 'crt_1', typeId: 'rt_badminton_court', name: 'Court 1', active: true });
      mockResourceTypeRepo.getById.mockResolvedValue({ id: 'rt_badminton_court', code: 'badminton_court' });
      mockReservationService.create.mockResolvedValue({
        reservation: fixtureReservation({ status: 'pending_payment' }),
        clientSecret: 'secret',
        holdExpiresAt: new Date(),
        totalCents: 1000,
      });
      mockReservationService.confirm.mockResolvedValue(fixtureReservation());

      const res = await app.inject({
        method: 'POST',
        url: '/api/me/bookings',
        headers: AUTH,
        payload: { facilityType: 'court', facilityId: 'crt_1', date: '2026-09-01', startTime: '18:00' },
      });

      expect(res.statusCode).toBe(201);
      expect(mockReservationService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          typeCode: 'badminton_court',
          date: '2026-09-01',
          slots: ['18:00'],
          organizerId: 'mem_1',
          resourceId: 'crt_1',
        }),
      );
      expect(mockReservationService.confirm).toHaveBeenCalledWith('rsv_1', { memberId: 'mem_1' });
    });

    it('lets a lapsed member cancel their own booking', async () => {
      signedInAs();
      mockMembershipChecker.hasActiveMembership.mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/me/bookings/bk_1', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.cancel).toHaveBeenCalledWith('bk_1', { memberId: 'mem_1' });
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

  describe('home aggregation (package F)', () => {
    it('aggregates through the home service, keyed on the principal member id', async () => {
      signedInAs();
      mockMemberService.getById.mockResolvedValue(fixtureMember());

      const res = await app.inject({ method: 'GET', url: '/api/me/home?tz=Asia/Hong_Kong', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockHomeService.getHome).toHaveBeenCalledWith('mem_1', { timezone: 'Asia/Hong_Kong' });
      expect(res.json().data.greeting).toEqual({
        firstName: 'Alice',
        timeOfDay: 'evening',
        timezone: 'America/New_York',
      });
    });

    it('serves upcoming reservations with participation status and the Weekly badge', async () => {
      signedInAs();
      mockMemberService.getById.mockResolvedValue(fixtureMember());
      mockHomeService.getHome.mockResolvedValue(
        fixtureHome({ upcomingReservations: [fixtureReservation({ seriesId: 'ser_1' })] }),
      );

      const res = await app.inject({ method: 'GET', url: '/api/me/home', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.upcomingReservations[0]).toMatchObject({
        reference: 'BK-001000',
        weekly: true,
        myParticipation: { role: 'organizer', status: 'confirmed' },
      });
    });

    it('renders pending invitations distinctly with the inviter first name for inline accept/decline', async () => {
      signedInAs({ memberId: 'mem_2' });
      mockMemberService.getById.mockResolvedValue(fixtureMember({ id: 'mem_2', email: 'guest@example.com' }));
      const invited = fixtureReservation({
        id: 'rsv_inv',
        participants: [
          {
            id: 'rp_1',
            reservationId: 'rsv_inv',
            memberId: 'mem_1',
            role: 'organizer',
            status: 'confirmed',
            invitedById: null,
            viaClubId: null,
            invitedAt: new Date('2026-08-01T00:00:00Z'),
            respondedAt: null,
            member: { id: 'mem_1', firstName: 'Alice', lastName: 'Chen', email: 'alice@example.com' },
          },
          {
            id: 'rp_2',
            reservationId: 'rsv_inv',
            memberId: 'mem_2',
            role: 'guest',
            status: 'pending',
            invitedById: 'mem_1',
            viaClubId: null,
            invitedAt: new Date('2026-08-02T00:00:00Z'),
            respondedAt: null,
            member: { id: 'mem_2', firstName: 'Gary', lastName: 'Guest', email: 'guest@example.com' },
          },
        ],
      });
      mockHomeService.getHome.mockResolvedValue(fixtureHome({ pendingInvitations: [invited] }));

      const res = await app.inject({ method: 'GET', url: '/api/me/home', headers: AUTH });

      expect(res.statusCode).toBe(200);
      const [invitation] = res.json().data.pendingInvitations;
      expect(invitation).toMatchObject({
        id: 'rsv_inv',
        myParticipation: {
          role: 'guest',
          status: 'pending',
          invitedByFirstName: 'Alice',
        },
      });
      expect(res.json().data.upcomingReservations).toEqual([]);
    });

    it('passes through club invitations, the quick-book suggestion and the empty-state amenities', async () => {
      signedInAs();
      mockMemberService.getById.mockResolvedValue(fixtureMember());
      mockHomeService.getHome.mockResolvedValue(
        fixtureHome({
          clubInvitations: [
            {
              id: 'inv_1',
              club: { id: 'club_1', name: 'Smashers', description: null, coverImageUrl: null, memberCount: 4 },
              invitedBy: { memberId: 'mem_9', firstName: 'Olivia', lastName: 'Ong' },
              createdAt: new Date('2026-08-20T00:00:00Z'),
            },
          ],
          quickBook: {
            typeCode: 'badminton_court',
            typeName: 'Badminton Court',
            date: '2026-09-03',
            startTime: '18:00',
            endTime: '19:00',
            durationMinutes: 60,
            hourlyRateCents: 2000,
            reason: 'You often book Badminton Court on Thursdays around 18:00',
          },
          emptyStateAmenities: [
            {
              typeCode: 'badminton_court',
              typeName: 'Badminton Court',
              hourlyRateCents: 2000,
              resourceCount: 3,
              availableSlotsToday: 12,
              locked: false,
            },
          ],
        }),
      );

      const res = await app.inject({ method: 'GET', url: '/api/me/home', headers: AUTH });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.clubInvitations).toEqual([
        expect.objectContaining({
          id: 'inv_1',
          club: expect.objectContaining({ name: 'Smashers' }),
          invitedBy: expect.objectContaining({ firstName: 'Olivia' }),
          createdAt: '2026-08-20T00:00:00.000Z',
        }),
      ]);
      expect(data.quickBook).toMatchObject({ typeCode: 'badminton_court', reason: expect.stringContaining('Thursdays') });
      expect(data.amenities).toEqual([expect.objectContaining({ typeCode: 'badminton_court', availableSlotsToday: 12 })]);
    });

    it('requires a member profile (403 before the aggregation runs)', async () => {
      signedInAs({ memberId: null });
      const res = await app.inject({ method: 'GET', url: '/api/me/home', headers: AUTH });
      expect(res.statusCode).toBe(403);
      expect(mockHomeService.getHome).not.toHaveBeenCalled();
    });
  });
});
