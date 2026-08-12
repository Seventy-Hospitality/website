/**
 * Pure booking-domain logic for the mobile reserve flow (package M3): venue
 * wall-clock slot math, contiguous multi-slot selection, price recompute,
 * money + date/time formatters, and the label helpers the Figma booking
 * screens use. Ported 1:1 from member-web/src/lib/booking.ts so the two
 * clients agree slot-for-slot and cent-for-cent. M2 (home) and M4
 * (reservations) reuse the formatters, since they render the same shapes.
 *
 * Slot labels are the backend's venue wall-clock "HH:MM" strings; hours may
 * reach 24+ for past-midnight slots ("24:30" is 00:30 the next day, still
 * counted against the anchor date). All math happens in minutes from
 * venue-local midnight, mirroring api/lib/contexts/bookings/domain/slots.ts.
 */

// ── Wall-clock label math ──

/** "HH:MM" to minutes from venue-local midnight (hours may exceed 24). */
export function timeLabelToMinutes(label: string): number {
  const [hours, minutes] = label.split(':').map(Number);
  return hours * 60 + minutes;
}

export function minutesToTimeLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** "21:30" -> "9:30PM" (the Figma slot style: no space before the meridiem). */
export function formatSlotTime(label: string): string {
  const minutes = timeLabelToMinutes(label) % (24 * 60);
  const hours24 = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const meridiem = hours24 < 12 ? 'AM' : 'PM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(rest).padStart(2, '0')}${meridiem}`;
}

/** One slot row label: "4:00PM - 4:30PM". */
export function formatSlotRange(start: string, slotDurationMinutes: number): string {
  const end = minutesToTimeLabel(timeLabelToMinutes(start) + slotDurationMinutes);
  return `${formatSlotTime(start)} - ${formatSlotTime(end)}`;
}

/**
 * Compact range for headers and cards: "9:30-11:30PM" (the first meridiem
 * is dropped when both ends share it, per the Figma).
 */
export function formatTimeRangeCompact(startLabel: string, endLabel: string): string {
  const start = formatSlotTime(startLabel);
  const end = formatSlotTime(endLabel);
  const meridiem = start.slice(-2);
  if (end.endsWith(meridiem)) {
    return `${start.slice(0, -2)}-${end}`;
  }
  return `${start}-${end}`;
}

// ── Date keys ("YYYY-MM-DD", venue-local) ──

/** Parses a date key to a Date at local noon (immune to DST edges). */
export function dateKeyToDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** Serializes a local-calendar Date back to its "YYYY-MM-DD" key. */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Intl formatters are expensive to build; one per zone is plenty. */
const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function dateKeyFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = dateKeyFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateKeyFormatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * The date key `now` falls on in `timezone`, normally the VENUE zone from
 * GET /api/venue: the backend defines "today" and the booking horizon on
 * the venue's wall clock, so near midnight the device zone and the venue
 * zone disagree on what "today" is. Expects a zone Intl can format with;
 * the caller (useVenueTimezone) validates that once and falls back to the
 * device zone otherwise.
 */
export function todayDateKey(timezone: string, now: Date = new Date()): string {
  const parts = dateKeyFormatter(timezone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addDaysToDateKey(key: string, days: number): string {
  const date = dateKeyToDate(key);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

/** Date-strip tile parts: { weekday: "MON", day: "6" }. */
export function formatStripDay(key: string): { weekday: string; day: string } {
  const date = dateKeyToDate(key);
  return {
    weekday: date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    day: String(date.getDate()),
  };
}

/** "Mon, Jul 6" (wizard step subtitle). */
export function formatDateHeading(key: string): string {
  const date = dateKeyToDate(key);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Monday, Jul 6" (checkout reservation card). */
export function formatDateLong(key: string): string {
  const date = dateKeyToDate(key);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/** "July 6, 2026" (confirmation sheet). */
export function formatDateFull(key: string): string {
  const date = dateKeyToDate(key);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * The booking horizon as date keys, today first. The backend allows
 * today + maxAdvanceDays inclusive.
 */
export function buildDateStrip(todayKey: string, maxAdvanceDays: number): string[] {
  const days = Math.max(0, maxAdvanceDays) + 1;
  return Array.from({ length: days }, (_, i) => addDaysToDateKey(todayKey, i));
}

// ── Contiguous multi-slot selection ──

/** Sorted by wall-clock position. */
function sortSlots(slots: string[]): string[] {
  return [...slots].sort((a, b) => timeLabelToMinutes(a) - timeLabelToMinutes(b));
}

/** True when the sorted selection has no gaps on the grid. */
export function isContiguous(slots: string[], slotDurationMinutes: number): boolean {
  const sorted = sortSlots(slots).map(timeLabelToMinutes);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + slotDurationMinutes) return false;
  }
  return true;
}

/**
 * Toggles a slot while keeping the selection contiguous (the backend
 * rejects gaps):
 *
 * - selecting next to an end of the current run extends the run;
 * - selecting away from the run starts a new selection at that slot;
 * - deselecting the first slot shrinks the run from the front;
 * - deselecting any other slot keeps the run up to (excluding) it, so the
 *   remainder is still gap-free.
 *
 * Returns the new selection sorted by time.
 */
export function toggleSlot(
  selected: string[],
  slot: string,
  slotDurationMinutes: number,
): string[] {
  const sorted = sortSlots(selected);
  const slotMinutes = timeLabelToMinutes(slot);
  const index = sorted.findIndex((entry) => timeLabelToMinutes(entry) === slotMinutes);

  if (index === -1) {
    if (sorted.length === 0) return [slot];
    const first = timeLabelToMinutes(sorted[0]);
    const last = timeLabelToMinutes(sorted[sorted.length - 1]);
    if (slotMinutes === first - slotDurationMinutes) return [slot, ...sorted];
    if (slotMinutes === last + slotDurationMinutes) return [...sorted, slot];
    return [slot];
  }

  if (index === 0) return sorted.slice(1);
  return sorted.slice(0, index);
}

/**
 * Keeps a selection valid after an availability refetch: drops slots that
 * are no longer bookable, then keeps the longest remaining contiguous run
 * (earliest on a tie) so the selection never carries a gap.
 */
export function pruneSelection(
  selected: string[],
  available: Iterable<string>,
  slotDurationMinutes: number,
): string[] {
  const availableSet = new Set(available);
  const kept = sortSlots(selected.filter((slot) => availableSet.has(slot)));
  if (kept.length === 0) return [];

  let best: string[] = [];
  let run: string[] = [kept[0]];
  for (let i = 1; i < kept.length; i++) {
    const prev = timeLabelToMinutes(kept[i - 1]);
    if (timeLabelToMinutes(kept[i]) === prev + slotDurationMinutes) {
      run.push(kept[i]);
    } else {
      if (run.length > best.length) best = run;
      run = [kept[i]];
    }
  }
  if (run.length > best.length) best = run;
  return best;
}

/**
 * Rebuilds the slot labels a reservation occupies from its wall-clock
 * range (used to restore the wizard draft after a payment failure).
 */
export function slotsFromRange(
  startTime: string,
  endTime: string,
  slotDurationMinutes: number,
): string[] {
  const start = timeLabelToMinutes(startTime);
  const end = timeLabelToMinutes(endTime);
  const slots: string[] = [];
  for (let minute = start; minute < end; minute += slotDurationMinutes) {
    slots.push(minutesToTimeLabel(minute));
  }
  return slots;
}

export interface SelectionSummary {
  /** Wall-clock labels of the selection edges. */
  startLabel: string;
  endLabel: string;
  durationMinutes: number;
  totalCents: number;
}

/** Integer cents, rounded half-up, mirroring the backend's computeTotalCents. */
export function computeTotalCents(hourlyRateCents: number, durationMinutes: number): number {
  return Math.round((hourlyRateCents * durationMinutes) / 60);
}

/**
 * Duration and client-side price preview for the current selection (the
 * server quote at checkout stays the source of truth). Null when empty.
 */
export function selectionSummary(
  selected: string[],
  slotDurationMinutes: number,
  hourlyRateCents: number,
): SelectionSummary | null {
  if (selected.length === 0) return null;
  const sorted = sortSlots(selected);
  const durationMinutes = sorted.length * slotDurationMinutes;
  return {
    startLabel: sorted[0],
    endLabel: minutesToTimeLabel(
      timeLabelToMinutes(sorted[sorted.length - 1]) + slotDurationMinutes,
    ),
    durationMinutes,
    totalCents: computeTotalCents(hourlyRateCents, durationMinutes),
  };
}

// ── Money ──

/** "$20" for whole dollars, "$2.50" otherwise (rates, chips). */
export function formatAmount(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Always two decimals: "$20.00" (totals, amount paid). */
export function formatAmountWithCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Misc labels ──

/** "2 hours" / "1 hour" / "90 min" per the Figma duration cells. */
export function formatDuration(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return `${minutes} min`;
}

/** "#BK-010492" from the backend reference ("BK-010492"). */
export function bookingRefLabel(reference: string): string {
  return `#${reference}`;
}

/**
 * The unit noun of an amenity type name: "Badminton Court" -> "court",
 * "Mahjong Table" -> "table", "Shower" -> "shower".
 */
export function resourceNoun(typeName: string): string {
  const words = typeName.trim().split(/\s+/);
  return (words[words.length - 1] ?? 'slot').toLowerCase();
}

/**
 * Browse-row subtitle: "4 courts available" / "1 simulator available" /
 * "2 available" (single-word names omit the noun, per the Figma shower row).
 */
export function availabilityCountLabel(typeName: string, count: number): string {
  const words = typeName.trim().split(/\s+/);
  if (words.length < 2) return `${count} available`;
  const noun = resourceNoun(typeName);
  return `${count} ${count === 1 ? noun : `${noun}s`} available`;
}

/** "Court fee" / "Table fee" from the type name (order-summary line). */
export function resourceFeeLabel(typeName: string): string {
  const noun = resourceNoun(typeName);
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} fee`;
}
