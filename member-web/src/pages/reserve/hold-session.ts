/**
 * The wizard-side ledger of the checkout hold (W3 booking).
 *
 * POST /api/reservations holds a slot server-side (pending_payment, ~12
 * minute TTL). The create request deliberately outlives the checkout step:
 * the member can back out (or leave the wizard entirely) while a create is
 * in flight, and re-entering checkout fires a fresh create. Responses can
 * therefore land out of order, and the client must never cancel the live
 * hold on behalf of an orphaned one.
 *
 * Money rule: once a payment has been submitted for the hold, the hold
 * must never be client-cancelled. Backend cancel of a paid pending_payment
 * settles the charge and refunds at the cancellation-policy percent (0%
 * within 2 hours of the start time), so a stray cancel turns a paid
 * booking into a charged-and-unrefunded nothing. Recovery of a paid hold
 * belongs to the confirm retry and the backend's paid-but-expired sweeper.
 *
 * The rules, in one framework-free place so they are directly testable:
 * - every create names an attempt token from beginAttempt();
 * - a hold that lands is adopted only when its token is still the live
 *   attempt; otherwise the INCOMING hold is cancelled, never the live one;
 * - release() invalidates the live attempt and cancels the held
 *   reservation, unless a submitted payment may have captured;
 * - settle() forgets the hold without cancelling (it was confirmed,
 *   expired, or handed to backend recovery).
 */

export interface HoldSession {
  /** Marks a new create attempt as the live one; returns its token. */
  beginAttempt(): number;
  /** Reports the hold a create attempt produced (possibly late). */
  holdCreated(reservationId: string, attempt: number): void;
  /**
   * Back-out: drop the live attempt and cancel the held reservation.
   * The cancel is skipped while a submitted payment may have captured
   * (see the money rule above). Always clears the payment lock.
   */
  release(): void;
  /**
   * Forget the hold without cancelling and clear the payment lock: it was
   * confirmed, already expired, or is being recovered server-side.
   */
  settle(): void;
  /** True from payment submit until the charge is known NOT captured. */
  readonly paymentLocked: boolean;
  setPaymentLocked(locked: boolean): void;
}

export function createHoldSession(options: {
  /** Fire-and-forget cancel of a reservation hold. */
  cancel: (reservationId: string) => void;
  /** Mirrors paymentLocked into the owner (e.g. React state). */
  onLockChange?: (locked: boolean) => void;
}): HoldSession {
  const { cancel, onLockChange } = options;
  let attempts = 0;
  let liveAttempt: number | null = null;
  let heldId: string | null = null;
  let paymentLocked = false;

  const setLock = (locked: boolean) => {
    if (paymentLocked === locked) return;
    paymentLocked = locked;
    onLockChange?.(locked);
  };

  return {
    beginAttempt() {
      liveAttempt = ++attempts;
      return liveAttempt;
    },
    holdCreated(reservationId, attempt) {
      if (attempt !== liveAttempt) {
        // An orphaned create (backed out, superseded, or the wizard is
        // gone) resolved late: cancel ITS hold; the live hold is untouched.
        cancel(reservationId);
        return;
      }
      // Belt-and-braces: one attempt makes one create, but if a previous
      // hold were somehow still recorded, free it before adopting this one.
      if (heldId && heldId !== reservationId) cancel(heldId);
      heldId = reservationId;
    },
    release() {
      liveAttempt = null;
      const id = heldId;
      heldId = null;
      if (id && !paymentLocked) cancel(id);
      setLock(false);
    },
    settle() {
      liveAttempt = null;
      heldId = null;
      setLock(false);
    },
    get paymentLocked() {
      return paymentLocked;
    },
    setPaymentLocked(locked) {
      setLock(locked);
    },
  };
}
