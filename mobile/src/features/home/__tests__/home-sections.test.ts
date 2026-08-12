import type { HomeFeed, Reservation } from '../../../lib/api';
import { greetingEyebrow, homeLayout, playerCountLabel } from '../home-sections';

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r1',
    reference: 'BK-1',
    typeCode: 'badminton_court',
    typeName: 'Badminton Court',
    resource: { id: 'court_1', name: 'Court 1' },
    date: '2026-08-20',
    startTime: '20:00',
    endTime: '21:00',
    startsAt: '2026-08-20T20:00:00.000Z',
    endsAt: '2026-08-20T21:00:00.000Z',
    durationMinutes: 60,
    status: 'confirmed',
    hourlyRateCents: 3000,
    amountPaidCents: 0,
    clubId: null,
    seriesId: null,
    weekly: false,
    createdByAdmin: false,
    participants: [
      { memberId: 'org', firstName: 'Olivia', lastName: 'Zha', role: 'organizer', status: 'confirmed', invitedById: null },
    ],
    pendingChange: null,
    myParticipation: { role: 'organizer', status: 'confirmed', invitedByName: null, invitedByFirstName: null },
    ...overrides,
  };
}

function makeFeed(overrides: Partial<HomeFeed> = {}): HomeFeed {
  return {
    member: {} as HomeFeed['member'],
    greeting: { firstName: 'Alice', timeOfDay: 'evening', timezone: 'America/Los_Angeles' },
    spotlightEvents: [],
    upcomingReservations: [],
    pendingInvitations: [],
    clubInvitations: [],
    quickBook: null,
    amenities: null,
    ...overrides,
  };
}

describe('homeLayout', () => {
  it('selects the empty state when the backend sends amenities (nothing upcoming)', () => {
    const layout = homeLayout(
      makeFeed({ amenities: [], quickBook: { typeCode: 'x' } as HomeFeed['quickBook'] }),
    );
    expect(layout.isEmpty).toBe(true);
    expect(layout.hasUpcoming).toBe(false);
    // Quick book is hidden in the empty state even though the payload carries it.
    expect(layout.showQuickBook).toBe(false);
  });

  it('selects the populated layout with quick book when amenities is null', () => {
    const layout = homeLayout(
      makeFeed({
        upcomingReservations: [makeReservation()],
        quickBook: { typeCode: 'mahjong_table' } as HomeFeed['quickBook'],
      }),
    );
    expect(layout.isEmpty).toBe(false);
    expect(layout.hasUpcoming).toBe(true);
    expect(layout.showQuickBook).toBe(true);
  });

  it('marks hasUpcoming when only pending invitations exist', () => {
    const layout = homeLayout(makeFeed({ pendingInvitations: [makeReservation()] }));
    expect(layout.isEmpty).toBe(false);
    expect(layout.hasUpcoming).toBe(true);
  });

  it('flags the club-invitations and spotlight sections independently', () => {
    const layout = homeLayout(
      makeFeed({
        clubInvitations: [{ id: 'c1' } as HomeFeed['clubInvitations'][number]],
        spotlightEvents: [{ id: 'e1' } as HomeFeed['spotlightEvents'][number]],
      }),
    );
    expect(layout.showClubInvitations).toBe(true);
    expect(layout.showSpotlight).toBe(true);
  });

  it('hides quick book when the payload has no suggestion', () => {
    expect(homeLayout(makeFeed({ upcomingReservations: [makeReservation()], quickBook: null })).showQuickBook).toBe(
      false,
    );
  });
});

describe('greetingEyebrow', () => {
  it('greets by time of day in the populated layout', () => {
    expect(greetingEyebrow('morning', false)).toBe('Good morning,');
    expect(greetingEyebrow('afternoon', false)).toBe('Good afternoon,');
    expect(greetingEyebrow('evening', false)).toBe('Good evening,');
  });

  it('welcomes a first-session member in the empty state', () => {
    expect(greetingEyebrow('morning', true)).toBe('Welcome,');
  });
});

describe('playerCountLabel', () => {
  it('counts confirmed + pending participants, singular for one', () => {
    expect(playerCountLabel(makeReservation())).toBe('1 player');
  });

  it('pluralizes and ignores declined/withdrawn rows', () => {
    const reservation = makeReservation({
      participants: [
        { memberId: 'org', firstName: 'O', lastName: 'Z', role: 'organizer', status: 'confirmed', invitedById: null },
        { memberId: 'g1', firstName: 'A', lastName: 'B', role: 'guest', status: 'pending', invitedById: 'org' },
        { memberId: 'g2', firstName: 'C', lastName: 'D', role: 'guest', status: 'declined', invitedById: 'org' },
      ],
    });
    expect(playerCountLabel(reservation)).toBe('2 players');
  });
});
