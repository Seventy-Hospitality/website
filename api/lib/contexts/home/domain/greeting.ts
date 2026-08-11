import { getZonedParts } from '@/lib/kernel';

// ── Greeting (pure) ──
// The home screen greets by first name + time of day in the VIEWER'S clock:
// a client-provided IANA zone when valid, the venue zone otherwise.

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/** Morning until noon, afternoon until 17:00, evening after. */
export function timeOfDayFor(now: Date, timeZone: string): TimeOfDay {
  const { hour } = getZonedParts(now, timeZone);
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * Canonicalize a client-supplied IANA zone name, null when invalid.
 *
 * Intl zone matching is case-insensitive ("aMeRiCa/nEw_yOrK" is accepted),
 * so the RAW client string must never flow further in: downstream keys a
 * formatter cache per distinct zone string, and the case-permutations of
 * every valid zone would grow it without bound. resolvedOptions() collapses
 * every accepted spelling to the one canonical name ("America/New_York").
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Whether a client-supplied string names a real IANA timezone. */
export function isValidTimeZone(value: unknown): value is string {
  return canonicalTimeZone(value) !== null;
}
