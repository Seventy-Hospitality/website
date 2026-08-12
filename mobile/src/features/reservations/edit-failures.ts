/**
 * Pure mapping of the reschedule engine's error codes onto the edit flow's
 * failure states (M4). Kept framework-free so the slot-taken / membership /
 * too-small-delta / stale-price branches are directly unit-testable,
 * mirroring member-web's describeEditFailure. The exact codes come from
 * api/src/lib/reservations.ts handleReservationError.
 */
import { ApiError } from '../../lib/api';

export type EditFailureKind = 'membership' | 'back-to-time' | 'retry';

export interface EditFailure {
  kind: EditFailureKind;
  message: string;
}

/** Maps a quote / PATCH ApiError onto an edit failure, or null if none. */
export function describeEditFailure(error: unknown): EditFailure | null {
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
          message: 'You have reached the booking limit for that day.',
        };
      case 'BOOKING_IN_PAST':
      case 'TOO_FAR_ADVANCE':
      case 'OUTSIDE_HOURS':
      case 'INVALID_SLOTS':
        return {
          kind: 'back-to-time',
          message: 'That time can no longer be booked. Pick another slot.',
        };
      case 'PAYMENT_TOO_SMALL':
        return {
          kind: 'back-to-time',
          message:
            'The price difference for this change is too small to charge. Pick a different time.',
        };
      case 'RESERVATION_CHANGED':
        return {
          kind: 'retry',
          message: 'The price of this change was updated. Review it and try again.',
        };
      case 'INVALID_STATUS':
        return {
          kind: 'back-to-time',
          message: 'This reservation changed while you were editing it.',
        };
      default:
        return { kind: 'retry', message: 'We could not prepare your change.' };
    }
  }
  return { kind: 'retry', message: 'We could not prepare your change.' };
}
