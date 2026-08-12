import { addDaysToDateKey, wallTimeToUtc, weekdayOfDateKey, zonedDateKey } from '@/lib/kernel';

// ── Weekly recurrence math (pure) ──
// A series is a venue-local weekday + wall-clock start time. Occurrences
// are the matching venue-local dates inside the booking horizon whose
// start instant is still in the future.

// Kernel venue-time math, re-exported for series consumers.
export { weekdayOfDateKey };

export interface SeriesOccurrenceQuery {
  /** 0 = Sunday .. 6 = Saturday, venue-local. */
  weekday: number;
  /** Wall-clock start, minutes from venue-local midnight. */
  startMinutes: number;
  /** The resource type's maxAdvanceDays booking horizon. */
  horizonDays: number;
  timeZone: string;
  now: Date;
}

/**
 * The venue-local dates (today .. today + horizon) on the series weekday
 * whose occurrence START is still in the future. Today's occurrence drops
 * out the moment its start time passes; the horizon boundary matches the
 * member-facing booking horizon so materialization never books further
 * ahead than a member could.
 */
export function listSeriesOccurrenceDates(query: SeriesOccurrenceQuery): string[] {
  const todayKey = zonedDateKey(query.now, query.timeZone);
  const dates: string[] = [];
  for (let offset = 0; offset <= query.horizonDays; offset += 1) {
    const dateKey = addDaysToDateKey(todayKey, offset);
    if (weekdayOfDateKey(dateKey) !== query.weekday) continue;
    if (wallTimeToUtc(dateKey, query.startMinutes, query.timeZone) <= query.now) continue;
    dates.push(dateKey);
  }
  return dates;
}
