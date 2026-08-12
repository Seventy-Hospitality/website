import { createHoldSession } from '../hold-session';

function setup() {
  const cancel = jest.fn();
  const onLockChange = jest.fn();
  const session = createHoldSession({ cancel, onLockChange });
  return { cancel, onLockChange, session };
}

describe('hold session (checkout hold ledger)', () => {
  it('adopts a hold whose attempt is still live and does not cancel it', () => {
    const { cancel, session } = setup();
    const attempt = session.beginAttempt();
    session.holdCreated('r1', attempt);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels an ORPHANED hold (stale attempt), never the live one', () => {
    const { cancel, session } = setup();
    const first = session.beginAttempt();
    const second = session.beginAttempt(); // supersedes the first
    // The first create resolves late with a now-stale token.
    session.holdCreated('orphan', first);
    expect(cancel).toHaveBeenCalledWith('orphan');
    // The live create adopts without cancelling.
    cancel.mockClear();
    session.holdCreated('live', second);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('release cancels the held reservation when no payment is in flight', () => {
    const { cancel, session } = setup();
    const attempt = session.beginAttempt();
    session.holdCreated('r1', attempt);
    session.release();
    expect(cancel).toHaveBeenCalledWith('r1');
  });

  it('release must NOT cancel a hold whose payment may have captured (money rule)', () => {
    const { cancel, onLockChange, session } = setup();
    const attempt = session.beginAttempt();
    session.holdCreated('r1', attempt);
    session.setPaymentLocked(true);
    expect(onLockChange).toHaveBeenCalledWith(true);
    session.release();
    expect(cancel).not.toHaveBeenCalled();
    // release always clears the lock.
    expect(onLockChange).toHaveBeenLastCalledWith(false);
    expect(session.paymentLocked).toBe(false);
  });

  it('settle forgets the hold without cancelling and clears the lock', () => {
    const { cancel, session } = setup();
    const attempt = session.beginAttempt();
    session.holdCreated('r1', attempt);
    session.setPaymentLocked(true);
    session.settle();
    expect(cancel).not.toHaveBeenCalled();
    expect(session.paymentLocked).toBe(false);
    // After settle, a later release has nothing to cancel.
    session.release();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a stale hold landing after release cancels itself, not a new live hold', () => {
    const { cancel, session } = setup();
    const first = session.beginAttempt();
    session.holdCreated('r1', first);
    session.release(); // backs out, cancels r1, clears live attempt
    expect(cancel).toHaveBeenCalledWith('r1');
    cancel.mockClear();
    // A brand new checkout entry begins and its create lands.
    const second = session.beginAttempt();
    session.holdCreated('r2', second);
    expect(cancel).not.toHaveBeenCalled();
  });
});
