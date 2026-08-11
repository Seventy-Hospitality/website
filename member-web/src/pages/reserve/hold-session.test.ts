import { describe, expect, it, vi } from 'vitest';
import { createHoldSession } from './hold-session';

/**
 * The checkout hold ledger. Create requests outlive the checkout step and
 * can resolve out of order, and a hold with a submitted payment must never
 * be client-cancelled; these tests pin those rules down.
 */
describe('createHoldSession', () => {
  function session() {
    const cancel = vi.fn<(id: string) => void>();
    const onLockChange = vi.fn<(locked: boolean) => void>();
    return { session: createHoldSession({ cancel, onLockChange }), cancel, onLockChange };
  }

  it('adopts the live attempt hold and cancels it on back-out', () => {
    const { session: s, cancel } = session();
    const attempt = s.beginAttempt();
    s.holdCreated('res1', attempt);
    expect(cancel).not.toHaveBeenCalled();

    s.release();
    expect(cancel).toHaveBeenCalledWith('res1');
  });

  it('cancels an orphaned late-resolving hold, never the live one', () => {
    // The remount ordering race: create A fires, the member backs out
    // (release) and re-enters (create B). B resolves first and is live;
    // A resolves LAST and must cancel ITSELF, not the live hold.
    const { session: s, cancel } = session();
    const attemptA = s.beginAttempt();
    s.release(); // backed out while A was in flight
    const attemptB = s.beginAttempt();
    s.holdCreated('res-live', attemptB);

    s.holdCreated('res-orphan', attemptA);
    expect(cancel).toHaveBeenCalledWith('res-orphan');
    expect(cancel).not.toHaveBeenCalledWith('res-live');

    // The live hold is still the one on the ledger.
    s.release();
    expect(cancel).toHaveBeenCalledWith('res-live');
  });

  it('cancels a hold that lands after the wizard released (hard unmount)', () => {
    const { session: s, cancel } = session();
    const attempt = s.beginAttempt();
    s.release(); // unmount cleanup ran while the create was in flight
    expect(cancel).not.toHaveBeenCalled();

    s.holdCreated('res1', attempt);
    expect(cancel).toHaveBeenCalledWith('res1');
  });

  it('a newer attempt supersedes an older in-flight one', () => {
    const { session: s, cancel } = session();
    const attemptA = s.beginAttempt();
    const attemptB = s.beginAttempt();
    s.holdCreated('res-b', attemptB);
    s.holdCreated('res-a', attemptA);
    expect(cancel).toHaveBeenCalledWith('res-a');
    expect(cancel).not.toHaveBeenCalledWith('res-b');
  });

  it('never cancels while the payment lock is held, and unlocks on release', () => {
    const { session: s, cancel, onLockChange } = session();
    s.holdCreated('res1', s.beginAttempt());
    s.setPaymentLocked(true);
    expect(onLockChange).toHaveBeenCalledWith(true);

    // Back/Close or unmount after the payment was submitted: the paid
    // hold must not be cancelled (backend cancel refunds at the policy
    // percent, 0% near start). Backend recovery owns it instead.
    s.release();
    expect(cancel).not.toHaveBeenCalled();
    expect(s.paymentLocked).toBe(false);
    expect(onLockChange).toHaveBeenLastCalledWith(false);
  });

  it('unlocking after a decline lets release cancel again', () => {
    const { session: s, cancel } = session();
    s.holdCreated('res1', s.beginAttempt());
    s.setPaymentLocked(true);
    s.setPaymentLocked(false); // definitive decline: nothing captured
    s.release();
    expect(cancel).toHaveBeenCalledWith('res1');
  });

  it('settle forgets the hold without cancelling and unlocks', () => {
    const { session: s, cancel } = session();
    const attempt = s.beginAttempt();
    s.holdCreated('res1', attempt);
    s.setPaymentLocked(true);

    s.settle(); // confirmed / expired / handed to backend recovery
    s.release();
    expect(cancel).not.toHaveBeenCalled();
    expect(s.paymentLocked).toBe(false);

    // A hold landing after settle is an orphan.
    s.holdCreated('res-late', attempt);
    expect(cancel).toHaveBeenCalledWith('res-late');
  });

  it('reports lock changes only on transitions', () => {
    const { session: s, onLockChange } = session();
    s.setPaymentLocked(true);
    s.setPaymentLocked(true);
    s.setPaymentLocked(false);
    s.setPaymentLocked(false);
    expect(onLockChange.mock.calls).toEqual([[true], [false]]);
  });
});
