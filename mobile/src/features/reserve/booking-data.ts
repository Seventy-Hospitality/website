/**
 * Shared react-query definitions and small hooks for the mobile booking flow
 * (package M3). Query-key conventions mirror member-web so M2/M4 can share
 * the prefixes for invalidation:
 *   ['resource-types']                 the amenity catalog
 *   ['availability', typeCode, date]   bookable slots for one day
 *   ['reservations', ...]              reservation reads (M2/M4 share prefix)
 *   ['clubs'] / ['clubs', id, 'members'] club list + roster
 *   ['members', 'search', q]           invite search
 *   ['venue']                          the venue IANA timezone
 *   ['reserve', 'membership']          entitlement status (M3-local)
 */
import { useMemo } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api, type HomeMember, type MembershipStatus } from '../../lib/api';
import { todayDateKey } from './booking';

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

export function memberSearchQuery(q: string) {
  return queryOptions({
    queryKey: ['members', 'search', q],
    queryFn: () => api.searchMembers(q),
    staleTime: 30_000,
  });
}

export const venueQuery = queryOptions({
  queryKey: ['venue'],
  queryFn: api.getVenue,
  staleTime: Infinity,
});

/**
 * Entitlement source for the active-member booking gate. The membership
 * status lives on the profile payload; we read just that here so the
 * Reserve tab and wizard can explain a LAPSED membership proactively
 * instead of only surfacing the backend's 403. Kept on an M3-local key so
 * it never collides with the M2 home / M6 profile caches.
 */
export const membershipQuery = queryOptions({
  queryKey: ['reserve', 'membership'],
  queryFn: () => api.getProfile().then((profile) => profile.member.membership),
  staleTime: 60_000,
});

export type MembershipView = HomeMember['membership'];

/**
 * The backend's active-member booking policy: only active/trialing
 * subscriptions may book (mirrors memberships isEntitledStatus). The
 * onboarding gate guarantees a membership was purchased; this catches a
 * LAPSED one so the flow explains itself instead of surfacing raw 403s.
 */
export function isEntitledMembershipStatus(status: MembershipStatus | undefined | null): boolean {
  return status === 'active' || status === 'trialing';
}

/**
 * The venue IANA timezone, the anchor for "today" and the booking horizon.
 * Every date the backend books against is on the venue's wall clock, so
 * near midnight the device zone and the venue zone disagree on "today".
 * While the query loads (or if the zone is unusable) this falls back to the
 * device zone, matching member-web's useVenueTimezone.
 */
export function useVenueTimezone(): string {
  const venue = useQuery(venueQuery);
  const deviceZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  return useMemo(() => {
    const zone = venue.data?.timezone;
    if (!zone) return deviceZone;
    // Guard against a zone Intl cannot format with (bad backend value).
    try {
      todayDateKey(zone);
      return zone;
    } catch {
      return deviceZone;
    }
  }, [venue.data?.timezone, deviceZone]);
}
