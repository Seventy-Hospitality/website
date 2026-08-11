/**
 * Pure reservation-lifecycle logic shared by the W4 detail/edit/cancel
 * surfaces (W2 home reuses the respond transition for its inline
 * accept/decline). Mirrors the backend rules in
 * api/lib/contexts/bookings/domain: the server stays the source of truth,
 * these mirrors only drive previews and optimistic UI.
 */
import type {
  Reservation,
  ReservationParticipantStatus,
  RescheduleQuote,
} from './api';
import { slotsFromRange, timeLabelToMinutes } from './booking';

// ── Cancellation refund tiers ──

/**
 * Mirror of the backend's refundPercentFor (cancellation-policy.ts):
 * more than 24h before start 100%, 2-24h 50%, inside 2h (or started) 0%.
 * The DELETE response's refundCents is authoritative; this mirror only
 * previews the tier in the cancel confirmation.
 */
export function refundPercentFor(startsAt: Date, now: Date): 100 | 50 | 0 {
  const minutesBefore = (startsAt.getTime() - now.getTime()) / 60_000;
  if (minutesBefore > 24 * 60) return 100;
  if (minutesBefore >= 2 * 60) return 50;
  return 0;
}

/** Mirror of the backend's computeRefundCents: floor at integer cents. */
export function computeRefundCents(netPaidCents: number, percent: number): number {
  return Math.floor((netPaidCents * percent) / 100);
}

export interface CancelRefundPreview {
  percent: 100 | 50 | 0;
  refundCents: number;
  /** Net paid so far (charges minus refunds), the refund base. */
  netPaidCents: number;
}

/** The refund the member would get for cancelling now. */
export function cancelRefundPreview(
  reservation: Pick<Reservation, 'startsAt' | 'amountPaidCents'>,
  now: Date = new Date(),
): CancelRefundPreview {
  const percent = refundPercentFor(new Date(reservation.startsAt), now);
  const netPaidCents = Math.max(0, reservation.amountPaidCents);
  return { percent, netPaidCents, refundCents: computeRefundCents(netPaidCents, percent) };
}

// ── Invitation responses (optimistic-update mirror) ──

export type ParticipantResponse = 'accept' | 'decline';

/**
 * Mirror of the backend participant state machine
 * (domain/reservation.ts applyParticipantResponse):
 *   pending   + accept  -> confirmed
 *   pending   + decline -> declined
 *   confirmed + decline -> withdrawn (withdraw after accept)
 *   confirmed + accept, declined + decline, withdrawn + decline: idempotent
 * Returns null for the invalid transitions (declined/withdrawn + accept):
 * changing your mind needs a re-invite, so the UI never offers it.
 */
export function applyParticipantResponse(
  status: ReservationParticipantStatus,
  response: ParticipantResponse,
): ReservationParticipantStatus | null {
  if (response === 'accept') {
    return status === 'pending' || status === 'confirmed' ? 'confirmed' : null;
  }
  if (status === 'confirmed') return 'withdrawn';
  if (status === 'withdrawn') return 'withdrawn';
  return 'declined';
}

// ── Reschedule (edit) helpers ──

/** The slot labels the reservation currently occupies. */
export function reservationSlots(
  reservation: Pick<Reservation, 'startTime' | 'endTime'>,
  slotDurationMinutes: number,
): string[] {
  return slotsFromRange(reservation.startTime, reservation.endTime, slotDurationMinutes);
}

/**
 * The edit wizard's dirty check: Save/Continue stays disabled until the
 * selection differs from the reservation's own date + slots.
 */
export function isSelectionChanged(
  reservation: Pick<Reservation, 'date' | 'startTime' | 'endTime'>,
  date: string,
  slots: string[],
  slotDurationMinutes: number,
): boolean {
  if (slots.length === 0) return false;
  if (date !== reservation.date) return true;
  const current = reservationSlots(reservation, slotDurationMinutes);
  if (slots.length !== current.length) return true;
  const sorted = [...slots].sort((a, b) => timeLabelToMinutes(a) - timeLabelToMinutes(b));
  return sorted.some((slot, index) => slot !== current[index]);
}

/**
 * Merges the reservation's OWN slots into a day's availability: the member
 * availability endpoint has no self-exclusion parameter, so the
 * reservation's current claim reads as taken; to itself it is free (the
 * backend reschedule self-excludes when validating candidates).
 */
export function mergeOwnSlots(available: string[], own: string[]): string[] {
  const merged = new Set(available);
  for (const slot of own) merged.add(slot);
  return [...merged].sort((a, b) => timeLabelToMinutes(a) - timeLabelToMinutes(b));
}

export type RescheduleMoneyKind = 'charge' | 'refund' | 'even';

export interface RescheduleMoney {
  kind: RescheduleMoneyKind;
  /** What the member pays now (0 unless kind is 'charge'). */
  dueTodayCents: number;
  /** What comes back to the card (0 unless kind is 'refund'). */
  refundCents: number;
  netPaidCents: number;
  newTotalCents: number;
}

/**
 * Which money path a reschedule quote takes: positive delta is an
 * incremental charge collected via the Payment Element before the move
 * applies; negative is a refund to the card, applied immediately with the
 * move; zero applies immediately with no money movement.
 */
export function describeRescheduleMoney(
  quote: Pick<RescheduleQuote, 'deltaCents' | 'netPaidCents' | 'newTotalCents'>,
): RescheduleMoney {
  const { deltaCents, netPaidCents, newTotalCents } = quote;
  if (deltaCents > 0) {
    return { kind: 'charge', dueTodayCents: deltaCents, refundCents: 0, netPaidCents, newTotalCents };
  }
  if (deltaCents < 0) {
    return { kind: 'refund', dueTodayCents: 0, refundCents: -deltaCents, netPaidCents, newTotalCents };
  }
  return { kind: 'even', dueTodayCents: 0, refundCents: 0, netPaidCents, newTotalCents };
}

// ── Viewer-facing state ──

/** True while the reservation still owns its slot (mirror of the backend). */
export function isActiveReservationStatus(status: Reservation['status']): boolean {
  return status === 'pending_payment' || status === 'confirmed';
}

/** True once the booked time has begun; edit/cancel are no longer offered. */
export function hasReservationStarted(
  reservation: Pick<Reservation, 'startsAt'>,
  now: Date = new Date(),
): boolean {
  return now.getTime() >= new Date(reservation.startsAt).getTime();
}
