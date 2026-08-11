import { weekdayOfDateKey } from '@/lib/kernel';

// ── Quick-book pattern (pure) ──
// The AI suggestion is deterministic frequency analysis over the member's
// recent confirmed bookings, no ML: most-booked amenity type, then the
// most-booked weekday within that type, then the most-booked start time
// and duration within that (type, weekday). Every tie breaks toward
// RECENCY, so the input list must be sorted most-recent-first (the
// bookings read guarantees it). The full recipe is recorded in
// docs/decisions-notifications.md.

export interface BookingHistoryEntry {
  typeCode: string;
  /** Venue-local "YYYY-MM-DD" of the booking. */
  localDate: string;
  /** Venue wall-clock start, minutes from local midnight. */
  startMinutes: number;
  durationMinutes: number;
}

export interface QuickBookPattern {
  typeCode: string;
  weekday: number; // 0 = Sunday .. 6 = Saturday
  startMinutes: number;
  durationMinutes: number;
}

/**
 * Most frequent key; ties break toward the key seen EARLIEST in the list
 * (which is the most recent entry, given most-recent-first input).
 */
function mostFrequent<T, K>(entries: T[], keyOf: (entry: T) => K): K | null {
  const counts = new Map<K, number>();
  const firstSeen = new Map<K, number>();
  entries.forEach((entry, index) => {
    const key = keyOf(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstSeen.has(key)) firstSeen.set(key, index);
  });

  let winner: K | null = null;
  for (const [key, count] of counts) {
    if (winner === null) {
      winner = key;
      continue;
    }
    const winnerCount = counts.get(winner)!;
    if (count > winnerCount || (count === winnerCount && firstSeen.get(key)! < firstSeen.get(winner)!)) {
      winner = key;
    }
  }
  return winner;
}

/**
 * Derive the member's booking habit from recent history (most-recent-first).
 * Null when there is no history: the caller falls back to the
 * most-available amenity or omits the suggestion.
 */
export function deriveQuickBookPattern(history: BookingHistoryEntry[]): QuickBookPattern | null {
  if (history.length === 0) return null;

  const typeCode = mostFrequent(history, (entry) => entry.typeCode)!;
  const ofType = history.filter((entry) => entry.typeCode === typeCode);

  const weekday = mostFrequent(ofType, (entry) => weekdayOfDateKey(entry.localDate))!;
  const ofWeekday = ofType.filter((entry) => weekdayOfDateKey(entry.localDate) === weekday);

  const startMinutes = mostFrequent(ofWeekday, (entry) => entry.startMinutes)!;
  const durationMinutes = mostFrequent(ofWeekday, (entry) => entry.durationMinutes)!;

  return { typeCode, weekday, startMinutes, durationMinutes };
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
