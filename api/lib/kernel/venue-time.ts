/**
 * Venue-time math shared across bounded contexts (scheduling, events).
 *
 * Time model: instants are UTC (timestamptz in the DB); the venue has a single
 * IANA timezone (VENUE_TIMEZONE, read in the container). Wall-clock positions
 * are minutes from venue-local midnight and may exceed 1440 for ranges that
 * run past midnight; a range counts against the local date of its start.
 *
 * DST: conversions go through the zone per boundary, so 19:00 stays 19:00
 * across transitions. Nonexistent wall times (spring-forward gap) and
 * ambiguous ones (fall-back repeat) resolve deterministically via the
 * two-pass offset fix-up below; slots straddling a transition may span 30/90
 * real minutes, which is accepted and documented.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Hard cap on cached formatters. There are only ~600 IANA zones, so a
 * well-behaved process never reaches it; it exists so that a caller who
 * feeds unexpected distinct strings (Intl accepts any case-permutation of
 * a valid zone) cannot grow process memory without bound. Client-supplied
 * zones must additionally be canonicalized before they get here (see
 * home/domain/greeting.ts).
 */
const MAX_CACHED_FORMATTERS = 1024;

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    if (partsFormatters.size >= MAX_CACHED_FORMATTERS) partsFormatters.clear();
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The wall-clock reading a zone shows for an instant. */
export function getZonedParts(value: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as "24" in some ICU versions; normalize.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Venue-local "YYYY-MM-DD" of an instant. */
export function zonedDateKey(value: Date, timeZone: string): string {
  const parts = getZonedParts(value, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * The instant at which a venue wall clock shows `minutesFromMidnight` past
 * midnight of `dateKey`. Minutes may exceed 1440 (rolls into the next day)
 * and the result is deterministic across DST gaps and repeats.
 */
export function wallTimeToUtc(dateKey: string, minutesFromMidnight: number, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const wallMs = Date.UTC(year, month - 1, day, 0, minutesFromMidnight, 0, 0);
  let guess = new Date(wallMs);

  // Two-pass offset fix-up: read what the zone shows for the guess, shift by
  // the difference. Converges for every real wall time; for nonexistent or
  // ambiguous wall times the second pass lands on a deterministic instant.
  for (let i = 0; i < 2; i++) {
    const shown = getZonedParts(guess, timeZone);
    const shownMs = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    const diff = wallMs - shownMs;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }

  return guess;
}

/**
 * Wall-clock minutes an instant sits past midnight of an anchor local date.
 * For an instant on the day after the anchor this exceeds 1440, matching the
 * operating-hours convention.
 */
export function zonedMinutesSinceMidnight(value: Date, timeZone: string, anchorDateKey: string): number {
  const parts = getZonedParts(value, timeZone);
  const wallMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const [year, month, day] = anchorDateKey.split('-').map(Number);
  const anchorMs = Date.UTC(year, month - 1, day);
  return Math.round((wallMs - anchorMs) / 60_000);
}

/**
 * Calendar weekday (0 = Sunday) of a venue-local "YYYY-MM-DD" date key. The
 * weekday of a local date is a property of the date itself; anchoring at
 * UTC noon dodges every timezone/DST edge.
 */
export function weekdayOfDateKey(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

/** "YYYY-MM-DD" plus N days, on the proleptic calendar (no zone involved). */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const next = new Date(`${dateKey}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * Minutes-from-midnight to "HH:MM". Hours may reach "24" and beyond for
 * past-midnight positions of the anchor date ("24:30" = 00:30 next day);
 * this keeps slot labels unambiguous about which local date they count on.
 */
export function minutesToTimeLabel(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** "HH:MM" (hours may exceed 24) to minutes-from-midnight. */
export function timeLabelToMinutes(label: string): number {
  const [h, m] = label.split(':').map(Number);
  return h * 60 + m;
}
