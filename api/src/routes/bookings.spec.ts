import type { FastifyInstance } from 'fastify';
import { SessionExpiredError } from '@/lib/contexts/identity';
import { SlotUnavailableError } from '@/lib/contexts/bookings';

const { mockReservationService, mockResourceRepo, mockResourceTypeRepo, mockMembershipChecker, mockSessionService } =
  vi.hoisted(() => ({
    mockReservationService: {
      create: vi.fn(),
      cancel: vi.fn().mockResolvedValue({ refundCents: 0 }),
      listAll: vi.fn().mockResolvedValue([]),
      getResourceAvailability: vi.fn().mockResolvedValue([]),
      countUpcomingForResources: vi.fn().mockResolvedValue(0),
    },
    mockResourceRepo: {
      listAll: vi.fn().mockResolvedValue([]),
      listByTypeIds: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    mockResourceTypeRepo: {
      listAll: vi.fn().mockResolvedValue([]),
      getByCode: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
    mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
  }));

vi.mock('@/lib/container', () => ({
  reservationService: mockReservationService,
  resourceRepo: mockResourceRepo,
  resourceTypeRepo: mockResourceTypeRepo,
  membershipChecker: mockMembershipChecker,
  sessionService: mockSessionService,
  VENUE_TIMEZONE: 'America/New_York',
}));

import { buildTestApp } from '@/src/test/app';
import { bookingRoutes } from './bookings';

const AUTH = { authorization: 'Bearer admin_jwt' } as const;

const BADMINTON_TYPE = {
  id: 'rt_badminton_court',
  code: 'badminton_court',
  name: 'Badminton Court',
  slotDurationMinutes: 30,
  opStartMinutes: 420,
  opEndMinutes: 1320,
  hourlyRateCents: 2000,
  maxAdvanceDays: 7,
  maxReservationsPerMemberPerDay: 2,
  cancellationDeadlineMinutes: 60,
  minTier: 'member',
  active: true,
  displayOrder: 0,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
};

const COURT_RESOURCE = {
  id: 'court-1',
  typeId: 'rt_badminton_court',
  name: 'Court 1',
  active: true,
  displayOrder: 0,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
};

function signedInAs(staffRole: 'admin' | 'staff' | null) {
  mockSessionService.validateAccessToken.mockResolvedValue({
    userId: 'usr_admin',
    sessionId: 'ses_1',
    email: 'boss@club70.nyc',
    emailVerified: true,
    staffRole,
    memberId: null,
    client: 'admin_web',
  });
}

describe('admin booking routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockResourceTypeRepo.listAll.mockResolvedValue([BADMINTON_TYPE]);
    mockResourceRepo.listByTypeIds.mockResolvedValue([COURT_RESOURCE]);
    mockReservationService.listAll.mockResolvedValue([]);
    app = await buildTestApp({ routes: bookingRoutes, prefix: '/api' });
  });

  afterEach(() => app.close());

  it('gates every route on the admin policy', async () => {
    signedInAs('staff');
    for (const [method, url] of [
      ['GET', '/api/courts'],
      ['GET', '/api/bookings'],
      ['GET', '/api/resource-types/all'],
      ['GET', '/api/resources'],
    ] as const) {
      const res = await app.inject({ method, url, headers: AUTH });
      expect(res.statusCode).toBe(403);
    }
  });

  it('lists court-class resources with flattened type config (legacy shape)', async () => {
    signedInAs('admin');

    const res = await app.inject({ method: 'GET', url: '/api/courts', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({
      id: 'court-1',
      name: 'Court 1',
      slotDurationMinutes: 30,
      operatingHoursStart: '07:00',
      operatingHoursEnd: '22:00',
      maxBookingsPerMemberPerDay: 2,
    });
  });

  it('books on a named resource as a comped admin reservation', async () => {
    signedInAs('admin');
    mockResourceRepo.getById.mockResolvedValue(COURT_RESOURCE);
    mockResourceTypeRepo.getById.mockResolvedValue(BADMINTON_TYPE);
    mockReservationService.create.mockResolvedValue({
      reservation: {
        id: 'rsv_1',
        reference: 'BK-001000',
        organizerId: 'mem_1',
        localDate: '2026-09-01',
        startsAt: new Date('2026-09-01T22:00:00.000Z'),
        endsAt: new Date('2026-09-01T22:30:00.000Z'),
        status: 'confirmed',
        resourceType: BADMINTON_TYPE,
        resource: { id: 'court-1', name: 'Court 1' },
        participants: [],
        payments: [],
        claim: null,
      },
      clientSecret: null,
      holdExpiresAt: null,
      totalCents: 1000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/courts/court-1/bookings',
      headers: AUTH,
      payload: { memberId: 'mem_1', date: '2026-09-01', startTime: '18:00' },
    });

    expect(res.statusCode).toBe(201);
    expect(mockReservationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        typeCode: 'badminton_court',
        organizerId: 'mem_1',
        resourceId: 'court-1',
        slots: ['18:00'],
        admin: { adminUserId: 'usr_admin' },
      }),
    );
  });

  it('maps a lost race on admin create to 409', async () => {
    signedInAs('admin');
    mockResourceRepo.getById.mockResolvedValue(COURT_RESOURCE);
    mockResourceTypeRepo.getById.mockResolvedValue(BADMINTON_TYPE);
    mockReservationService.create.mockRejectedValue(new SlotUnavailableError());

    const res = await app.inject({
      method: 'POST',
      url: '/api/courts/court-1/bookings',
      headers: AUTH,
      payload: { memberId: 'mem_1', date: '2026-09-01', startTime: '18:00' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('cancels with a full refund from the admin surface', async () => {
    signedInAs('admin');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/courts/court-1/bookings/rsv_1',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(mockReservationService.cancel).toHaveBeenCalledWith('rsv_1', {
      fullRefund: true,
      actorId: 'usr_admin',
    });
  });

  it('serves single-resource availability for the admin picker', async () => {
    signedInAs('admin');
    mockReservationService.getResourceAvailability.mockResolvedValue([{ startTime: '18:00', endTime: '18:30' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/courts/court-1/availability?date=2026-09-01',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(mockReservationService.getResourceAvailability).toHaveBeenCalledWith('court-1', '2026-09-01');
    expect(res.json().data).toEqual([{ startTime: '18:00', endTime: '18:30' }]);
  });

  it('applies legacy facility config edits to the resource type', async () => {
    signedInAs('admin');
    mockResourceRepo.getById.mockResolvedValue(COURT_RESOURCE);
    mockResourceTypeRepo.getById.mockResolvedValue(BADMINTON_TYPE);
    mockResourceTypeRepo.update.mockResolvedValue({ ...BADMINTON_TYPE, opEndMinutes: 1380 });
    mockResourceRepo.update.mockResolvedValue({ ...COURT_RESOURCE, name: 'Center Court' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/courts/court-1',
      headers: AUTH,
      payload: { name: 'Center Court', operatingHoursEnd: '23:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockResourceTypeRepo.update).toHaveBeenCalledWith('rt_badminton_court', { opEndMinutes: 1380 });
    expect(mockResourceRepo.update).toHaveBeenCalledWith('court-1', { name: 'Center Court' });
  });

  it('rejects a duplicate resource type code', async () => {
    signedInAs('admin');
    mockResourceTypeRepo.getByCode.mockResolvedValue(BADMINTON_TYPE);

    const res = await app.inject({
      method: 'POST',
      url: '/api/resource-types',
      headers: AUTH,
      payload: {
        code: 'badminton_court',
        name: 'Badminton Court',
        opStartMinutes: 420,
        opEndMinutes: 1320,
        hourlyRateCents: 2000,
        maxAdvanceDays: 7,
        maxReservationsPerMemberPerDay: 2,
        cancellationDeadlineMinutes: 60,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(mockResourceTypeRepo.create).not.toHaveBeenCalled();
  });
});
