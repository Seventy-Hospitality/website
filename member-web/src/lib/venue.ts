/**
 * The venue timezone, THE wall clock for every calendar computation in the
 * app: the booking date strip and horizon (W3, W4's edit wizard) and the
 * billing ledger's venue-local months and row dates (W6).
 *
 * `useVenueTimezone()` is the single source components read; they pass the
 * zone into the pure date helpers (`todayDateKey(timezone)`,
 * `instantDateLabel(iso, timezone)`, ...). Never call the hook inside a
 * helper and never compute a calendar date from a bare `new Date()`.
 *
 * The zone comes from GET /api/venue (public: a physical club's timezone
 * is public knowledge) and can never change at runtime, so the query is
 * cached for the life of the tab and prefetched at app start (main.tsx).
 * Until it loads, or if the request fails or returns a zone this browser
 * cannot format with, the hook falls back to the browser zone: correct for
 * a member in the venue's zone (the overwhelming case) and never blocking
 * or crashing a surface on a config read.
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from './api';

export const venueQuery = queryOptions({
  queryKey: ['venue'],
  queryFn: api.getVenue,
  staleTime: Infinity,
  gcTime: Infinity,
});

/** The device's IANA zone: the documented fallback, never the preference. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** True when Intl on this browser can format in the zone. Validated here,
    once, so the pure date helpers can trust the zone they are handed. */
function isUsableTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The venue's IANA timezone; the browser zone only while the venue query
    is loading or after it failed. Components read this and pass it down. */
export function useVenueTimezone(): string {
  const { data } = useQuery(venueQuery);
  const timezone = data?.timezone;
  return timezone !== undefined && isUsableTimezone(timezone) ? timezone : browserTimezone();
}
