import { describe, expect, it } from 'vitest';
import type { HomeFeed, Reservation, ReservationParticipant } from './api';
import { applyResponseToHome } from './reservation-respond';

/**
 * The optimistic home-feed write behind the inline invitation actions:
 * accept moves the card into the upcoming list (sorted by start, viewer
 * row flipped), decline drops it, withdrawing drops an upcoming row.
 */

const SELF = 'm-self';

function participant(
  memberId: string,
  status: ReservationParticipant['status'],
): ReservationParticipant {
  return {
    memberId,
    firstName: 'First',
    lastName: 'Last',
    role: memberId === SELF ? 'guest' : 'organizer',
    status,
    invitedById: memberId === SELF ? 'm-org' : null,
  };
}

function reservation(id: string, startsAt: string, selfStatus: 'pending' | 'confirmed'): Reservation {
  return {
    id,
    reference: `BK-${id}`,
    typeCode: 'badminton_court',
    typeName: 'Badminton Court',
    resource: { id: 'c1', name: 'Court 1' },
    date: '2026-07-26',
    startTime: '09:00',
    endTime: '10:30',
    startsAt,
    endsAt: startsAt,
    durationMinutes: 90,
    status: 'confirmed',
    hourlyRateCents: 6000,
    amountPaidCents: 9000,
    clubId: null,
    seriesId: null,
    weekly: false,
    createdByAdmin: false,
    participants: [participant('m-org', 'confirmed'), participant(SELF, selfStatus)],
    pendingChange: null,
    myParticipation: {
      role: 'guest',
      status: selfStatus,
      invitedByName: 'Sarah Kim',
      invitedByFirstName: 'Sarah',
    },
  };
}

function homeFixture(): HomeFeed {
  return {
    member: {
      id: SELF,
      email: 'x@example.com',
      firstName: 'Olivia',
      lastName: 'Zha',
      phone: null,
      memberNumber: 'A12345',
      displayName: null,
      avatarUrl: null,
      memberSince: '2026-01-01T00:00:00.000Z',
      membership: null,
    },
    greeting: { firstName: 'Olivia', timeOfDay: 'morning', timezone: 'UTC' },
    spotlightEvents: [],
    upcomingReservations: [
      reservation('r-early', '2026-07-20T13:00:00.000Z', 'confirmed'),
      reservation('r-late', '2026-07-30T13:00:00.000Z', 'confirmed'),
    ],
    pendingInvitations: [reservation('r-inv', '2026-07-26T13:00:00.000Z', 'pending')],
    clubInvitations: [],
    quickBook: null,
    amenities: null,
  };
}

describe('applyResponseToHome', () => {
  it('accept moves the invitation into upcoming, sorted by start, with the viewer row confirmed', () => {
    const next = applyResponseToHome(homeFixture(), 'r-inv', SELF, 'accept');

    expect(next.pendingInvitations).toHaveLength(0);
    expect(next.upcomingReservations.map((row) => row.id)).toEqual(['r-early', 'r-inv', 'r-late']);
    const moved = next.upcomingReservations[1];
    expect(moved.myParticipation?.status).toBe('confirmed');
    expect(moved.participants.find((row) => row.memberId === SELF)?.status).toBe('confirmed');
  });

  it('decline removes the invitation and leaves upcoming untouched', () => {
    const next = applyResponseToHome(homeFixture(), 'r-inv', SELF, 'decline');
    expect(next.pendingInvitations).toHaveLength(0);
    expect(next.upcomingReservations.map((row) => row.id)).toEqual(['r-early', 'r-late']);
  });

  it('declining an upcoming reservation (withdraw) removes that row', () => {
    const next = applyResponseToHome(homeFixture(), 'r-early', SELF, 'decline');
    expect(next.upcomingReservations.map((row) => row.id)).toEqual(['r-late']);
    expect(next.pendingInvitations.map((row) => row.id)).toEqual(['r-inv']);
  });

  it('an unknown reservation leaves the feed unchanged', () => {
    const home = homeFixture();
    expect(applyResponseToHome(home, 'r-nope', SELF, 'accept')).toBe(home);
  });
});
