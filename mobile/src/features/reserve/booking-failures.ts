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
