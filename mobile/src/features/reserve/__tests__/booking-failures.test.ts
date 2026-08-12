import { ApiError } from '../../../lib/api';
import {
  describeBookingFailure,
  isPaymentClearing,
  isTerminalHoldError,
} from '../booking-failures';

const err = (code: string, status = 409) => new ApiError(code, `${code} message`, status);

describe('describeBookingFailure (quote/create error -> checkout state)', () => {
  it('sends a just-taken slot back to time selection', () => {
    const failure = describeBookingFailure(err('SLOT_UNAVAILABLE'));
    expect(failure).toEqual({
      kind: 'back-to-time',
      message: 'That time was just taken by another member. Pick another slot.',
    });
  });

  it('maps membership problems to the membership gate, keeping the server message', () => {
    expect(describeBookingFailure(err('INACTIVE_MEMBERSHIP', 403))).toEqual({
      kind: 'membership',
      message: 'INACTIVE_MEMBERSHIP message',
    });
    expect(describeBookingFailure(err('TIER_REQUIRED', 403))?.kind).toBe('membership');
  });

  it('sends limit / horizon / hours errors back to time selection', () => {
    for (const code of ['MAX_BOOKINGS', 'BOOKING_IN_PAST', 'TOO_FAR_ADVANCE', 'OUTSIDE_HOURS', 'INVALID_SLOTS']) {
      expect(describeBookingFailure(err(code, 422))?.kind).toBe('back-to-time');
    }
  });

  it('asks the member to review invites when an invitee or club is gone', () => {
    expect(describeBookingFailure(err('INVITEE_NOT_FOUND', 404))?.kind).toBe('retry');
    expect(describeBookingFailure(err('CLUB_NOT_FOUND', 404))?.kind).toBe('retry');
  });

  it('falls back to a generic retry, and is null with no error', () => {
    expect(describeBookingFailure(err('SOMETHING_ELSE', 500))?.kind).toBe('retry');
    expect(describeBookingFailure(new Error('boom'))?.kind).toBe('retry');
    expect(describeBookingFailure(null)).toBeNull();
  });
});

describe('confirm-time error classification', () => {
  it('treats a still-clearing charge as non-terminal (re-check, do not retry)', () => {
    expect(isPaymentClearing(err('PAYMENT_REQUIRED', 402))).toBe(true);
    expect(isTerminalHoldError(err('PAYMENT_REQUIRED', 402))).toBe(false);
  });

  it('treats an expired / consumed / missing hold as terminal', () => {
    expect(isTerminalHoldError(err('HOLD_EXPIRED'))).toBe(true);
    expect(isTerminalHoldError(err('INVALID_STATUS'))).toBe(true);
    expect(isTerminalHoldError(err('NOT_FOUND', 404))).toBe(true);
    expect(isTerminalHoldError(err('SLOT_UNAVAILABLE'))).toBe(false);
  });
});
