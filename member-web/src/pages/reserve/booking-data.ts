/**
 * Shared react-query definitions for the booking flow (package W3).
 * Query-key conventions (CONVENTIONS.md):
 *   ['resource-types']                       the amenity catalog
 *   ['availability', typeCode, date]         bookable slots per day
 *   ['reservations', ...]                    reservation reads (W2/W4 share
 *                                            the prefix for invalidation)
 *   ['clubs'] / ['clubs', id, 'members']     club list + roster (W5 owns
 *                                            the full clubs flow)
 *   ['members', 'search', q]                 invite search
 */
import { queryOptions } from '@tanstack/react-query';
import { api, type MembershipStatus } from '../../lib/api';

export const resourceTypesQuery = queryOptions({
  queryKey: ['resource-types'],
  queryFn: api.getResourceTypes,
  staleTime: 60_000,
});

/** One day of bookable slots. Volatile: other members are booking too. */
export function availabilityQuery(typeCode: string, date: string) {
  return queryOptions({
    queryKey: ['availability', typeCode, date],
    queryFn: () => api.getAvailability(typeCode, { date }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export const myClubsQuery = queryOptions({
  queryKey: ['clubs'],
  queryFn: api.getMyClubs,
  staleTime: 60_000,
});

export function clubRosterQuery(clubId: string) {
  return queryOptions({
    queryKey: ['clubs', clubId, 'members'],
    queryFn: () => api.getClubMembers(clubId),
    staleTime: 60_000,
  });
}

export function memberSearchQuery(q: string) {
  return queryOptions({
    queryKey: ['members', 'search', q],
    queryFn: () => api.searchMembers(q),
    staleTime: 30_000,
  });
}

export function reservationQuery(id: string) {
  return queryOptions({
    queryKey: ['reservations', id],
    queryFn: () => api.getReservation(id),
  });
}

/**
 * The backend's active-member booking policy: only active/trialing
 * subscriptions may book (mirrors memberships isEntitledStatus). The
 * OnboardingGate guarantees a membership was purchased; this catches a
 * LAPSED one so the flow explains itself instead of surfacing raw 403s.
 */
export function isEntitledMembershipStatus(status: MembershipStatus | undefined | null): boolean {
  return status === 'active' || status === 'trialing';
}
