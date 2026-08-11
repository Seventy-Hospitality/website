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

/** Whether a client-supplied string names a real IANA timezone. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
