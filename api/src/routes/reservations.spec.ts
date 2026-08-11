import type { FastifyInstance } from 'fastify';
import { SessionExpiredError } from '@/lib/contexts/identity';
import {
  NotInvitePermittedError,
  ReservationNotFoundError,
  SlotUnavailableError,
  TierRequiredError,
} from '@/lib/contexts/bookings';

const { mockReservationService, mockSeriesService, mockMembershipChecker, mockSessionService } = vi.hoisted(() => ({
  mockReservationService: {
    listResourceTypesForMember: vi.fn().mockResolvedValue([]),
    getAvailability: vi.fn().mockResolvedValue([]),
    quote: vi.fn(),
    create: vi.fn(),
    confirm: vi.fn(),
    getForViewer: vi.fn(),
    rescheduleQuote: vi.fn(),
    reschedule: vi.fn(),
    cancel: vi.fn().mockResolvedValue({ refundCents: 0 }),
    addParticipants: vi.fn(),
    removeParticipant: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn(),
  },
  mockSeriesService: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    cancel: vi.fn().mockResolvedValue({ cancelled: true, occurrencesCancelled: 0 }),
  },
  mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
  mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
}));

vi.mock('@/lib/container', () => ({
  reservationService: mockReservationService,
  seriesService: mockSeriesService,
  membershipChecker: mockMembershipChecker,
  sessionService: mockSessionService,
  VENUE_TIMEZONE: 'America/New_York',
}));

import { buildTestApp } from '@/src/test/app';
import { reservationRoutes } from './reservations';

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

function fixtureReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rsv_1',
    reference: 'BK-001000',
    resourceTypeId: 'rt_badminton_court',
    resourceId: 'crt_1',
    organizerId: 'mem_1',
    clubId: null,
    seriesId: null,
    startsAt: new Date('2026-09-01T22:00:00.000Z'),
    endsAt: new Date('2026-09-01T23:00:00.000Z'),
    localDate: '2026-09-01',
    status: 'pending_payment',
    hourlyRateCentsSnapshot: 2000,
    amountPaidCents: 0,
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

describe('reservation routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockMembershipChecker.hasActiveMembership.mockResolvedValue(true);
    mockReservationService.listResourceTypesForMember.mockResolvedValue([]);
    mockReservationService.getAvailability.mockResolvedValue([]);
    mockReservationService.cancel.mockResolvedValue({ refundCents: 0 });
    app = await buildTestApp({ routes: reservationRoutes, prefix: '/api' });
  });

  afterEach(() => app.close());

  describe('GET /api/venue', () => {
    it('serves the venue timezone without a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/venue' });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ timezone: 'America/New_York' });
    });
  });

  describe('GET /api/resource-types', () => {
    it('requires a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/resource-types' });
      expect(res.statusCode).toBe(401);
    });

    it('requires a member profile', async () => {
      signedInAs({ memberId: null });
      const res = await app.inject({ method: 'GET', url: '/api/resource-types', headers: AUTH });
      expect(res.statusCode).toBe(403);
    });

    it('serializes the catalog with lock flags', async () => {
      signedInAs();
      mockReservationService.listResourceTypesForMember.mockResolvedValue([
        {
          code: 'shower',
          name: 'Shower',
          slotDurationMinutes: 30,
          opStartMinutes: 420,
          opEndMinutes: 1320,
          hourlyRateCents: 1000,
          maxAdvanceDays: 3,
          minTier: 'pro',
          locked: true,
          resourceCount: 2,
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/resource-types', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.listResourceTypesForMember).toHaveBeenCalledWith('mem_1');
      expect(res.json().data[0]).toMatchObject({ code: 'shower', locked: true, minTier: 'pro', icon: 'shower' });
    });
  });

  describe('GET /api/resource-types/:code/availability', () => {
    it('requires an ACTIVE membership', async () => {
      signedInAs();
      mockMembershipChecker.hasActiveMembership.mockResolvedValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/api/resource-types/badminton_court/availability?date=2026-09-01',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(403);
      expect(mockReservationService.getAvailability).not.toHaveBeenCalled();
    });

    it('passes the viewer and window through', async () => {
      signedInAs();

      const res = await app.inject({
        method: 'GET',
        url: '/api/resource-types/badminton_court/availability?date=2026-09-01&days=3',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.getAvailability).toHaveBeenCalledWith({
        typeCode: 'badminton_court',
        startDate: '2026-09-01',
        days: 3,
        memberId: 'mem_1',
      });
    });

    it('passes the edit flow self-exclusion through', async () => {
      signedInAs();

      const res = await app.inject({
        method: 'GET',
        url: '/api/resource-types/badminton_court/availability?date=2026-09-01&excludeReservationId=rsv_9',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.getAvailability).toHaveBeenCalledWith({
        typeCode: 'badminton_court',
        startDate: '2026-09-01',
        days: undefined,
        memberId: 'mem_1',
        excludeReservationId: 'rsv_9',
      });
    });

    it('maps a foreign excludeReservationId to 404', async () => {
      signedInAs();
      mockReservationService.getAvailability.mockRejectedValue(new ReservationNotFoundError('rsv_9'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/resource-types/badminton_court/availability?date=2026-09-01&excludeReservationId=rsv_9',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(404);
    });

    it('maps the PRO gate to 403', async () => {
      signedInAs();
      mockReservationService.getAvailability.mockRejectedValue(new TierRequiredError('pro'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/resource-types/shower/availability?date=2026-09-01',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('TIER_REQUIRED');
    });
  });

  describe('POST /api/reservations', () => {
    it('books for the principal as organizer and returns the checkout payload', async () => {
      signedInAs();
      mockReservationService.create.mockResolvedValue({
        reservation: fixtureReservation(),
        clientSecret: 'pi_secret',
        holdExpiresAt: new Date('2026-08-01T00:12:00Z'),
        totalCents: 2000,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/reservations',
        headers: AUTH,
        payload: {
          typeCode: 'badminton_court',
          date: '2026-09-01',
          slots: ['18:00', '18:30'],
          invitees: { memberIds: ['mem_2'] },
        },
      });

      expect(res.statusCode).toBe(201);
      expect(mockReservationService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          typeCode: 'badminton_court',
          organizerId: 'mem_1',
          inviteeMemberIds: ['mem_2'],
          actorId: 'usr_1',
        }),
      );
      expect(res.json().data).toMatchObject({
        clientSecret: 'pi_secret',
        totalCents: 2000,
        reservation: { reference: 'BK-001000', startTime: '18:00' },
      });
    });

    it('maps a lost slot race to 409', async () => {
      signedInAs();
      mockReservationService.create.mockRejectedValue(new SlotUnavailableError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/reservations',
        headers: AUTH,
        payload: { typeCode: 'badminton_court', date: '2026-09-01', slots: ['18:00'] },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('passes club invitees through to the service (package D)', async () => {
      signedInAs();
      mockReservationService.create.mockResolvedValue({
        reservation: fixtureReservation(),
        totalCents: 2000,
        clientSecret: 'pi_secret',
        holdExpiresAt: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/reservations',
        headers: AUTH,
        payload: {
          typeCode: 'badminton_court',
          date: '2026-09-01',
          slots: ['18:00'],
          invitees: { memberIds: ['mem_2'], clubIds: ['club_1'] },
        },
      });

      expect(res.statusCode).toBe(201);
      expect(mockReservationService.create).toHaveBeenCalledWith(
        expect.objectContaining({ inviteeMemberIds: ['mem_2'], inviteeClubIds: ['club_1'] }),
      );
    });

    it('validates the body', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/reservations',
        headers: AUTH,
        payload: { typeCode: 'badminton_court', date: 'tomorrow', slots: [] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/reservations/:id/confirm', () => {
    it('confirms through the service with the principal as viewer', async () => {
      signedInAs();
      mockReservationService.confirm.mockResolvedValue(fixtureReservation({ status: 'confirmed' }));

      const res = await app.inject({ method: 'POST', url: '/api/reservations/rsv_1/confirm', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.confirm).toHaveBeenCalledWith('rsv_1', { memberId: 'mem_1', actorId: 'usr_1' });
      expect(res.json().data.status).toBe('confirmed');
    });

    it('404s for non-organizers (service-level ownership)', async () => {
      signedInAs();
      mockReservationService.confirm.mockRejectedValue(new ReservationNotFoundError('rsv_1'));

      const res = await app.inject({ method: 'POST', url: '/api/reservations/rsv_1/confirm', headers: AUTH });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/reservations/:id', () => {
    it('serves participants with viewer flags', async () => {
      signedInAs();
      mockReservationService.getForViewer.mockResolvedValue({
        reservation: fixtureReservation({ status: 'confirmed' }),
        viewer: { role: 'organizer', status: 'confirmed', canInvite: true, canManage: true, canRespond: false },
      });

      const res = await app.inject({ method: 'GET', url: '/api/reservations/rsv_1', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.getForViewer).toHaveBeenCalledWith('rsv_1', 'mem_1');
      expect(res.json().data.viewer.canManage).toBe(true);
    });

    it('404s outsiders instead of leaking existence', async () => {
      signedInAs();
      mockReservationService.getForViewer.mockRejectedValue(new ReservationNotFoundError('rsv_1'));

      const res = await app.inject({ method: 'GET', url: '/api/reservations/rsv_1', headers: AUTH });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('reschedule', () => {
    it('requires an active membership', async () => {
      signedInAs();
      mockMembershipChecker.hasActiveMembership.mockResolvedValue(false);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/reservations/rsv_1',
        headers: AUTH,
        payload: { date: '2026-09-02', slots: ['18:00'] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('quotes and applies through the service', async () => {
      signedInAs();
      mockReservationService.rescheduleQuote.mockResolvedValue({ deltaCents: -1000 });
      mockReservationService.reschedule.mockResolvedValue({
        reservation: fixtureReservation({ status: 'confirmed' }),
        deltaCents: -1000,
        clientSecret: null,
      });

      const quoteRes = await app.inject({
        method: 'POST',
        url: '/api/reservations/rsv_1/reschedule-quote',
        headers: AUTH,
        payload: { date: '2026-09-02', slots: ['18:00'] },
      });
      expect(quoteRes.statusCode).toBe(200);
      expect(mockReservationService.rescheduleQuote).toHaveBeenCalledWith('rsv_1', 'mem_1', {
        date: '2026-09-02',
        slots: ['18:00'],
      });

      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/reservations/rsv_1',
        headers: AUTH,
        payload: { date: '2026-09-02', slots: ['18:00'] },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().data.deltaCents).toBe(-1000);
    });
  });

  describe('DELETE /api/reservations/:id', () => {
    it('cancels for a lapsed member (policy member, not active-member)', async () => {
      signedInAs();
      mockMembershipChecker.hasActiveMembership.mockResolvedValue(false);
      mockReservationService.cancel.mockResolvedValue({ refundCents: 1000 });

      const res = await app.inject({ method: 'DELETE', url: '/api/reservations/rsv_1', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.cancel).toHaveBeenCalledWith('rsv_1', { memberId: 'mem_1', actorId: 'usr_1' });
      expect(res.json().data).toEqual({ cancelled: true, refundCents: 1000 });
    });
  });

  describe('participants', () => {
    it('adds invitees through the service', async () => {
      signedInAs();
      mockReservationService.addParticipants.mockResolvedValue({ invited: ['mem_2'] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/reservations/rsv_1/participants',
        headers: AUTH,
        payload: { memberIds: ['mem_2'] },
      });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.addParticipants).toHaveBeenCalledWith(
        'rsv_1',
        'mem_1',
        { memberIds: ['mem_2'], clubIds: undefined },
        'usr_1',
      );
    });

    it('maps invite-permission denial to 403', async () => {
      signedInAs();
      mockReservationService.addParticipants.mockRejectedValue(new NotInvitePermittedError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/reservations/rsv_1/participants',
        headers: AUTH,
        payload: { memberIds: ['mem_2'] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('removes a participant (organizer enforced in the service)', async () => {
      signedInAs();

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/reservations/rsv_1/participants/mem_2',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.removeParticipant).toHaveBeenCalledWith('rsv_1', 'mem_1', 'mem_2', 'usr_1');
    });

    it('responds to an invitation', async () => {
      signedInAs();
      mockReservationService.respond.mockResolvedValue({ status: 'confirmed' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/reservations/rsv_1/respond',
        headers: AUTH,
        payload: { response: 'accept' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockReservationService.respond).toHaveBeenCalledWith('rsv_1', 'mem_1', 'accept', 'usr_1');
    });

    it('rejects an invalid response payload', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/reservations/rsv_1/respond',
        headers: AUTH,
        payload: { response: 'maybe' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('weekly series (admin-only creation, OPEN decision 8)', () => {
    const fixtureSeries = {
      id: 'ser_1',
      organizerId: 'mem_1',
      resourceTypeId: 'rt_badminton_court',
      weekday: 4,
      startTimeLocal: '18:00',
      durationMinutes: 60,
      active: true,
      createdByAdminId: 'usr_admin',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      resourceType: { id: 'rt_badminton_court', code: 'badminton_court', name: 'Badminton Court' },
      organizer: { id: 'mem_1', firstName: 'Alice', lastName: 'Chen', memberNumber: 'A12345' },
    };

    it('keeps every series route off-limits to plain members', async () => {
      signedInAs(); // member, no staff role
      for (const [method, url] of [
        ['GET', '/api/admin/reservation-series'],
        ['POST', '/api/admin/reservation-series'],
        ['DELETE', '/api/admin/reservation-series/ser_1'],
      ] as const) {
        const res = await app.inject({ method, url, headers: AUTH, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(res.statusCode).toBe(403);
      }
      expect(mockSeriesService.create).not.toHaveBeenCalled();
      expect(mockSeriesService.cancel).not.toHaveBeenCalled();
    });

    it('creates a series for the named member as the acting admin', async () => {
      signedInAs({ userId: 'usr_admin', staffRole: 'admin', memberId: null });
      mockSeriesService.create.mockResolvedValue(fixtureSeries);

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/reservation-series',
        headers: AUTH,
        payload: {
          memberId: 'mem_1',
          typeCode: 'badminton_court',
          weekday: 4,
          startTime: '18:00',
          durationMinutes: 60,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(mockSeriesService.create).toHaveBeenCalledWith({
        organizerId: 'mem_1',
        typeCode: 'badminton_court',
        weekday: 4,
        startTime: '18:00',
        durationMinutes: 60,
        adminUserId: 'usr_admin',
      });
      expect(res.json().data).toMatchObject({
        id: 'ser_1',
        typeCode: 'badminton_court',
        weekday: 4,
        startTime: '18:00',
        active: true,
        member: { memberNumber: 'A12345' },
      });
    });

    it('validates the series payload', async () => {
      signedInAs({ userId: 'usr_admin', staffRole: 'admin', memberId: null });
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/reservation-series',
        headers: AUTH,
        payload: { memberId: 'mem_1', typeCode: 'badminton_court', weekday: 9, startTime: '18:00', durationMinutes: 60 },
      });
      expect(res.statusCode).toBe(400);
      expect(mockSeriesService.create).not.toHaveBeenCalled();
    });

    it('cancels a series (and its future occurrences) as the acting admin', async () => {
      signedInAs({ userId: 'usr_admin', staffRole: 'admin', memberId: null });
      mockSeriesService.cancel.mockResolvedValue({ cancelled: true, occurrencesCancelled: 3 });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/admin/reservation-series/ser_1',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(mockSeriesService.cancel).toHaveBeenCalledWith('ser_1', 'usr_admin');
      expect(res.json().data).toEqual({ cancelled: true, occurrencesCancelled: 3 });
    });

    it('lists series for staff review', async () => {
      signedInAs({ userId: 'usr_admin', staffRole: 'admin', memberId: null });
      mockSeriesService.list.mockResolvedValue([fixtureSeries]);

      const res = await app.inject({ method: 'GET', url: '/api/admin/reservation-series', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([
        expect.objectContaining({ id: 'ser_1', typeName: 'Badminton Court', durationMinutes: 60 }),
      ]);
    });
  });

  describe('weekly badge on serialized reservations', () => {
    it('marks a series-materialized reservation weekly', async () => {
      signedInAs();
      mockReservationService.getForViewer.mockResolvedValue({
        reservation: fixtureReservation({ seriesId: 'ser_1' }),
        viewer: { role: 'organizer', status: 'confirmed', canInvite: true, canManage: true, canRespond: false },
      });

      const res = await app.inject({ method: 'GET', url: '/api/reservations/rsv_1', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ seriesId: 'ser_1', weekly: true });
    });
  });
});
