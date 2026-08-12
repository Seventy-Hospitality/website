import { ApiError } from '../../../lib/api';
import {
  classifyReissueError,
  classifyReissueResult,
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

describe('reissue disposition (money-lock safety after a failed PaymentSheet)', () => {
  // The load-bearing invariant the reserve review turns on: the payment lock
  // is cleared for EXACTLY ONE disposition — 'retry-in-place' — because that
  // is the only proven-unpaid outcome. Every other path keeps the lock so a
  // client cancel can never settle a possibly-captured hold at the
  // cancellation percent (0% within 2h of start).
  const clearsLock = (kind: string) => kind === 'retry-in-place';

  it('settles (keeps the lock) when the previous intent already captured', () => {
    const d = classifyReissueResult({ alreadyPaid: true, clientSecret: null, expiresAt: null });
    expect(d.kind).toBe('paid');
    expect(clearsLock(d.kind)).toBe(false);
  });

  it('unlocks and retries in place ONLY when a fresh secret was minted', () => {
    const d = classifyReissueResult({
      alreadyPaid: false,
      clientSecret: 'pi_new_secret',
      expiresAt: '2026-08-12T10:12:00.000Z',
    });
    expect(d).toEqual({
      kind: 'retry-in-place',
      clientSecret: 'pi_new_secret',
      expiresAt: '2026-08-12T10:12:00.000Z',
    });
    expect(clearsLock(d.kind)).toBe(true);
  });

  it('keeps the lock on an unexpected response with neither capture nor secret', () => {
    // The backend does not produce this for a live hold; treat as indeterminate
    // rather than unlocking on an unproven-unpaid state.
    const d = classifyReissueResult({ alreadyPaid: false, clientSecret: null, expiresAt: null });
    expect(d.kind).toBe('recover');
    expect(clearsLock(d.kind)).toBe(false);
  });

  it('routes a terminal (gone) hold to the sweeper WITHOUT unlocking', () => {
    for (const code of ['HOLD_EXPIRED', 'INVALID_STATUS', 'NOT_FOUND']) {
      const d = classifyReissueError(err(code, code === 'NOT_FOUND' ? 404 : 409));
      expect(d.kind).toBe('expired');
      expect(clearsLock(d.kind)).toBe(false);
    }
  });

  it('keeps the lock on an indeterminate reissue failure (network / 5xx / non-terminal)', () => {
    // The exact loss window in the finding: a network throw or a 5xx while the
    // original charge may have captured must NEVER unlock the hold.
    const cases: unknown[] = [
      new TypeError('Network request failed'),
      err('UNKNOWN', 500),
      err('SERVER_ERROR', 503),
      new Error('boom'),
      err('SLOT_UNAVAILABLE', 409),
    ];
    for (const e of cases) {
      const d = classifyReissueError(e);
      expect(d.kind).toBe('recover');
      expect(clearsLock(d.kind)).toBe(false);
    }
  });
});
