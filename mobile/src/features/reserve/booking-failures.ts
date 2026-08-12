/**
 * Pure mapping of the reservation engine's error codes onto the checkout's
 * failure states (M3). Kept framework-free so the slot-taken / hold-expired
 * / invite-not-found / membership branches are directly unit-testable,
 * mirroring member-web's describeBookingFailure. The exact codes come from
 * api/src/lib/reservations.ts handleReservationError.
 */
import { ApiError } from '../../lib/api';

export type BookingFailureKind = 'membership' | 'back-to-time' | 'retry';

export interface BookingFailure {
  kind: BookingFailureKind;
  message: string;
}

/** Maps a quote/create ApiError onto a checkout failure, or null if none. */
export function describeBookingFailure(error: unknown): BookingFailure | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'SLOT_UNAVAILABLE':
        return {
          kind: 'back-to-time',
          message: 'That time was just taken by another member. Pick another slot.',
        };
      case 'INACTIVE_MEMBERSHIP':
      case 'TIER_REQUIRED':
        return { kind: 'membership', message: error.message };
      case 'MAX_BOOKINGS':
        return {
          kind: 'back-to-time',
          message: 'You have reached the booking limit for this day.',
        };
      case 'BOOKING_IN_PAST':
      case 'TOO_FAR_ADVANCE':
      case 'OUTSIDE_HOURS':
      case 'INVALID_SLOTS':
        return {
          kind: 'back-to-time',
          message: 'That time can no longer be booked. Pick another slot.',
        };
      case 'INVITEE_NOT_FOUND':
      case 'CLUB_NOT_FOUND':
        return {
          kind: 'retry',
          message: 'One of your invites could not be found. Go back and review your invites.',
        };
      default:
        return { kind: 'retry', message: 'We could not prepare your booking.' };
    }
  }
  return { kind: 'retry', message: 'We could not prepare your booking.' };
}

/**
 * A confirm (post-payment) error that means the hold is gone: the money, if
 * any captured, is auto-refunded by the backend sweeper, so the client
 * settles rather than cancels. `PAYMENT_REQUIRED` (402) is NOT terminal:
 * the charge reached Stripe and is still clearing, so the client re-checks.
 */
export function isTerminalHoldError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'HOLD_EXPIRED' ||
      error.code === 'INVALID_STATUS' ||
      error.code === 'NOT_FOUND')
  );
}

/** The charge reached Stripe but has not cleared yet (async payment method). */
export function isPaymentClearing(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PAYMENT_REQUIRED';
}

/**
 * What the checkout should do after attempting a payment-intent reissue on a
 * failed PaymentSheet result. This is the money-lock decision, kept pure so it
 * is directly testable: the payment lock (which blocks a client cancel of a
 * possibly-paid hold) may be cleared for exactly ONE of these outcomes.
 *
 *  - `paid`           the previous intent actually captured: keep the lock and
 *                     settle the hold to a confirmed booking (never cancel it).
 *  - `retry-in-place` a fresh intent was minted, which the backend does only
 *                     AFTER retiring the old one at Stripe (provably
 *                     uncapturable). This is the ONLY proven-unpaid outcome, so
 *                     it is the only one that clears the lock and lets the
 *                     member retry on the fresh secret.
 *  - `expired`        the hold is gone server-side; the backend's paid-but-
 *                     expired sweeper owns any captured charge (full refund /
 *                     re-acquire). Keep the lock so the follow-on navigation
 *                     RELEASES WITHOUT a client cancel — a DELETE of a captured
 *                     hold settles at the cancellation percent (0% within 2h of
 *                     start), losing the money.
 *  - `recover`        an indeterminate outcome (network / 5xx, or a response
 *                     with neither a capture nor a fresh secret). The original
 *                     intent's capture state is UNKNOWN, so the lock stays on
 *                     and the member re-runs the reissue.
 *
 * The invariant the reserve money-safety review turns on: only `retry-in-place`
 * clears the lock. Every ambiguous path keeps it.
 */
export type ReissueDisposition =
  | { kind: 'paid' }
  | { kind: 'retry-in-place'; clientSecret: string; expiresAt: string | null }
  | { kind: 'expired' }
  | { kind: 'recover' };

/** Classify a SUCCESSFUL reissue response into a lock-safe disposition. */
export function classifyReissueResult(result: {
  alreadyPaid: boolean;
  clientSecret: string | null;
  expiresAt: string | null;
}): ReissueDisposition {
  if (result.alreadyPaid) return { kind: 'paid' };
  if (result.clientSecret) {
    return { kind: 'retry-in-place', clientSecret: result.clientSecret, expiresAt: result.expiresAt };
  }
  // Neither a capture nor a fresh secret: an outcome the backend does not
  // produce for a live hold. Do NOT unlock on an unproven-unpaid state.
  return { kind: 'recover' };
}

/** Classify a THROWN reissue error into a lock-safe disposition. */
export function classifyReissueError(error: unknown): ReissueDisposition {
  if (isTerminalHoldError(error)) return { kind: 'expired' };
  return { kind: 'recover' };
}
