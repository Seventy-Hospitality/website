import { HomeService } from './home.service';
import { MemberNotFoundError } from '@/lib/contexts/members';
import type { HomeAmenity } from './ports';

const TZ = 'America/New_York';
// Tue 2026-09-01, 09:00 New York.
const NOW = new Date('2026-09-01T13:00:00.000Z');

function amenity(overrides: Partial<HomeAmenity> = {}): HomeAmenity {
  return {
    code: 'badminton_court',
    name: 'Badminton Court',
    hourlyRateCents: 2000,
    locked: false,
    resourceCount: 3,
    slotDurationMinutes: 30,
    maxAdvanceDays: 14,
    ...overrides,
  };
}

function participant(memberId: string, status: string, role = 'guest') {
  return { memberId, status, role, member: { id: memberId, firstName: 'X', lastName: 'Y', email: 'x@y.z' } };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rsv_1',
    seriesId: null,
    startsAt: new Date('2026-09-01T22:00:00.000Z'),
    endsAt: new Date('2026-09-01T23:00:00.000Z'),
    localDate: '2026-09-01',
    participants: [participant('mem_1', 'confirmed', 'organizer')],
    ...overrides,
  } as never;
}

function build() {
  const members = {
    getProfile: vi.fn(async () => ({ id: 'mem_1', firstName: 'Alice', displayName: null })),
  };
  const bookings = {
    hasActiveMembership: vi.fn(async () => true),
    listUpcomingForMember: vi.fn(async () => [] as never[]),
    listRecentConfirmedHistory: vi.fn(async () => [] as never[]),
    listAmenitiesForMember: vi.fn(async () => [amenity()]),
    listAvailableStarts: vi.fn(async (_memberId: string, _typeCode: string, _date: string) => [] as string[]),
    fitsSingleResource: vi.fn(async () => true),
  };
  const clubs = { listPendingInvitations: vi.fn(async () => [] as never[]) };
  const events = { listUpcoming: vi.fn(async () => [] as never[]) };

  const service = new HomeService(members as never, bookings as never, clubs as never, events as never, TZ);
  return { service, members, bookings, clubs, events };
}

describe('HomeService.getHome: composition + IDOR safety', () => {
  it('keys every port read on the caller member id', async () => {
    const { service, members, bookings, clubs } = build();

    await service.getHome('mem_1', { now: NOW });

    expect(members.getProfile).toHaveBeenCalledWith('mem_1');
    expect(bookings.listUpcomingForMember).toHaveBeenCalledWith('mem_1');
    expect(bookings.listRecentConfirmedHistory).toHaveBeenCalledWith('mem_1');
    expect(bookings.listAmenitiesForMember).toHaveBeenCalledWith('mem_1');
    expect(clubs.listPendingInvitations).toHaveBeenCalledWith('mem_1');
  });

  it('404-shapes a deleted member', async () => {
    const { service, members } = build();
    members.getProfile.mockResolvedValue(null as never);
    await expect(service.getHome('mem_gone', { now: NOW })).rejects.toThrow(MemberNotFoundError);
  });

  it('greets by first name in the client timezone when valid, venue zone otherwise', async () => {
    const { service } = build();

    const hk = await service.getHome('mem_1', { now: NOW, timezone: 'Asia/Hong_Kong' });
    expect(hk.greeting).toEqual({ firstName: 'Alice', timeOfDay: 'evening', timezone: 'Asia/Hong_Kong' });

    const bogus = await service.getHome('mem_1', { now: NOW, timezone: 'Not/AZone' });
    expect(bogus.greeting).toEqual({ firstName: 'Alice', timeOfDay: 'morning', timezone: TZ });
  });

  it('canonicalizes the client timezone: the raw casing never flows downstream', async () => {
    const { service } = build();

    // Intl accepts any case-permutation; the raw string must not become a
    // formatter-cache key (unbounded distinct valid inputs otherwise).
    const home = await service.getHome('mem_1', { now: NOW, timezone: 'aSiA/hOnG_kOnG' });
    expect(home.greeting).toEqual({ firstName: 'Alice', timeOfDay: 'evening', timezone: 'Asia/Hong_Kong' });
  });

  it('splits pending invitations out of the upcoming list by the VIEWER participation', async () => {
    const { service, bookings } = build();
    const confirmed = reservation({ id: 'rsv_conf', participants: [participant('mem_1', 'confirmed', 'organizer')] });
    const invited = reservation({ id: 'rsv_inv', participants: [participant('mem_1', 'pending'), participant('mem_9', 'confirmed', 'organizer')] });
    const declined = reservation({ id: 'rsv_dec', participants: [participant('mem_1', 'declined')] });
    bookings.listUpcomingForMember.mockResolvedValue([confirmed, invited, declined] as never);

    const home = await service.getHome('mem_1', { now: NOW });

    expect(home.upcomingReservations.map((r) => (r as { id: string }).id)).toEqual(['rsv_conf']);
    expect(home.pendingInvitations.map((r) => (r as { id: string }).id)).toEqual(['rsv_inv']);
    expect(home.emptyStateAmenities).toBeNull(); // not the empty state
  });

  it('serves the amenity summary ONLY in the empty state, with counts and rates', async () => {
    const { service, bookings } = build();
    bookings.listAmenitiesForMember.mockResolvedValue([
      amenity(),
      amenity({ code: 'tennis_simulator', name: 'Tennis Simulator', hourlyRateCents: 4000, locked: true, resourceCount: 1 }),
    ]);
    bookings.listAvailableStarts.mockResolvedValue(['09:00', '09:30', '10:00']);

    const home = await service.getHome('mem_1', { now: NOW });

    expect(home.emptyStateAmenities).toEqual([
      expect.objectContaining({
        typeCode: 'badminton_court',
        typeName: 'Badminton Court',
        hourlyRateCents: 2000,
        resourceCount: 3,
        availableSlotsToday: 3,
        locked: false,
      }),
      // Tier-locked types render with the lock, never with phantom slots.
      expect.objectContaining({ typeCode: 'tennis_simulator', locked: true, availableSlotsToday: 0 }),
    ]);
  });
});

describe('HomeService quick-book', () => {
  const thursdayHistory = [
    { typeCode: 'badminton_court', localDate: '2026-08-27', startMinutes: 18 * 60, durationMinutes: 60 },
    { typeCode: 'badminton_court', localDate: '2026-08-20', startMinutes: 18 * 60, durationMinutes: 60 },
    { typeCode: 'tennis_court', localDate: '2026-08-19', startMinutes: 9 * 60, durationMinutes: 60 },
  ];

  it('suggests the habitual slot on the next matching weekday, with the reason', async () => {
    const { service, bookings } = build();
    bookings.listRecentConfirmedHistory.mockResolvedValue(thursdayHistory as never);
    bookings.listAvailableStarts.mockResolvedValue(['17:30', '18:00', '18:30', '19:00']);

    const home = await service.getHome('mem_1', { now: NOW });

    expect(home.quickBook).toEqual({
      typeCode: 'badminton_court',
      typeName: 'Badminton Court',
      date: '2026-09-03', // next Thursday after Tue 2026-09-01
      startTime: '18:00',
      endTime: '19:00',
      durationMinutes: 60,
      hourlyRateCents: 2000,
      reason: 'You often book Badminton Court on Thursdays around 18:00',
    });
    expect(bookings.fitsSingleResource).toHaveBeenCalledWith(
      'mem_1',
      'badminton_court',
      '2026-09-03',
      ['18:00', '18:30'],
    );
  });

  it('is deterministic: the same state yields the same suggestion', async () => {
    const { service, bookings } = build();
    bookings.listRecentConfirmedHistory.mockResolvedValue(thursdayHistory as never);
    bookings.listAvailableStarts.mockResolvedValue(['18:00', '18:30']);

    const first = await service.getHome('mem_1', { now: NOW });
    const second = await service.getHome('mem_1', { now: NOW });
    expect(second.quickBook).toEqual(first.quickBook);
  });

  it('slides to the nearest contiguous fit when the habitual time is taken', async () => {
    const { service, bookings } = build();
    bookings.listRecentConfirmedHistory.mockResolvedValue(thursdayHistory as never);
    // 18:00 missing; nearest contiguous hour starts at 18:30.
    bookings.listAvailableStarts.mockResolvedValue(['18:30', '19:00', '19:30']);

    const home = await service.getHome('mem_1', { now: NOW });

    expect(home.quickBook).toMatchObject({ date: '2026-09-03', startTime: '18:30', endTime: '19:30' });
  });

  it('union availability that no single resource can host is rejected via the fit check', async () => {
    const { service, bookings } = build();
    bookings.listRecentConfirmedHistory.mockResolvedValue(thursdayHistory as never);
    bookings.listAvailableStarts
      .mockResolvedValueOnce(['18:00', '18:30']) // next Thursday: fragmented across resources
      .mockResolvedValueOnce(['18:00', '18:30']); // the Thursday after
    bookings.fitsSingleResource.mockResolvedValue(false);

    const home = await service.getHome('mem_1', { now: NOW });

    // Both Thursdays failed the fit check; no-history-style fallback also
    // finds nothing (fit check false everywhere): the suggestion is omitted.
    expect(home.quickBook).toBeNull();
  });

  it('falls back to the most-available amenity when there is no history', async () => {
    const { service, bookings } = build();
    bookings.listAmenitiesForMember.mockResolvedValue([
      amenity(),
      amenity({ code: 'mahjong_table', name: 'Mahjong Table', resourceCount: 2, hourlyRateCents: 1000 }),
    ]);
    bookings.listAvailableStarts.mockImplementation(async (_m: string, typeCode: string) =>
      typeCode === 'mahjong_table' ? ['10:00', '10:30', '11:00', '11:30'] : ['10:00'],
    );

    const home = await service.getHome('mem_1', { now: NOW });

    expect(home.quickBook).toMatchObject({
      typeCode: 'mahjong_table',
      date: '2026-09-01',
      startTime: '10:00',
      endTime: '11:00',
      durationMinutes: 60,
      reason: 'Mahjong Table has the most availability today',
    });
  });

  it('omits the suggestion when nothing is bookable at all', async () => {
    const { service, bookings } = build();
    bookings.listAvailableStarts.mockResolvedValue([]);

    const home = await service.getHome('mem_1', { now: NOW });

    expect(home.quickBook).toBeNull();
  });

  it('a lapsed membership suggests nothing: every amenity is unbookable regardless of tier', async () => {
    const { service, bookings } = build();
    bookings.hasActiveMembership.mockResolvedValue(false);
    bookings.listRecentConfirmedHistory.mockResolvedValue(thursdayHistory as never);
    bookings.listAvailableStarts.mockResolvedValue(['18:00', '18:30', '19:00']);

    const home = await service.getHome('mem_1', { now: NOW });

    // No quick-book (POST /api/reservations would 403 INACTIVE_MEMBERSHIP),
    // and the empty-state summary shows the amenity locked with no slots.
    expect(home.quickBook).toBeNull();
    expect(home.emptyStateAmenities).toEqual([
      expect.objectContaining({ typeCode: 'badminton_court', locked: true, availableSlotsToday: 0 }),
    ]);
    // The lapsed member's home never probes availability or quotes at all.
    expect(bookings.listAvailableStarts).not.toHaveBeenCalled();
    expect(bookings.fitsSingleResource).not.toHaveBeenCalled();
  });

  it('a habit for a now-locked amenity falls back instead of suggesting the locked type', async () => {
    const { service, bookings } = build();
    bookings.listRecentConfirmedHistory.mockResolvedValue(thursdayHistory as never);
    bookings.listAmenitiesForMember.mockResolvedValue([
      amenity({ locked: true }), // badminton now behind a tier
      amenity({ code: 'mahjong_table', name: 'Mahjong Table' }),
    ]);
    bookings.listAvailableStarts.mockImplementation(async (_m: string, typeCode: string) =>
      typeCode === 'mahjong_table' ? ['10:00', '10:30'] : [],
    );

    const home = await service.getHome('mem_1', { now: NOW });

    expect(home.quickBook).toMatchObject({ typeCode: 'mahjong_table' });
  });
});
