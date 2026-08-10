/**
 * Payment-ledger math shared across bounded contexts (bookings settlement and
 * billing). Pure; operates on a minimal payment-row shape so both contexts'
 * records can use it. This is THE single implementation of net-paid and
 * newest-first refund allocation: do not duplicate it per context.
 */

export type PaymentRowKind = 'charge' | 'refund';
export type PaymentRowStatus = 'pending' | 'succeeded' | 'failed';

export interface PaymentLike {
  kind: PaymentRowKind;
  amountCents: number; // always positive; kind carries the direction
  status: PaymentRowStatus;
  stripePaymentIntentId?: string | null;
  createdAt?: Date;
  /**
   * Financial freeze: a disputed charge cannot be refunded at Stripe, so it
   * contributes nothing to refundable balance while still counting as
   * captured money.
   */
  disputedAt?: Date | null;
}

export class InsufficientRefundableBalanceError extends Error {
  constructor() {
    super('Refund exceeds the refundable balance for this reservation');
    this.name = 'InsufficientRefundableBalanceError';
  }
}

/**
 * Net money captured: succeeded charges minus refunds. Refunds count while
 * still PENDING: refunds are reserved in the mutating transaction before
 * Stripe runs, and a reserved refund is money already committed to leave, so
 * every concurrent money path must treat it as gone (fail closed). Charges
 * count only once actually captured; a disputed charge still counts (the
 * money was captured; the dispute freezes refunds, not the balance).
 */
export function computeNetPaidCents(
  payments: Array<Pick<PaymentLike, 'kind' | 'amountCents' | 'status'>>,
): number {
  return payments.reduce((net, payment) => {
    if (payment.kind === 'charge') {
      return payment.status === 'succeeded' ? net + payment.amountCents : net;
    }
    return payment.status === 'succeeded' || payment.status === 'pending'
      ? net - payment.amountCents
      : net;
  }, 0);
}

export interface RefundAllocation {
  stripePaymentIntentId: string | null;
  amountCents: number;
}

type AllocatablePayment = Pick<
  PaymentLike,
  'kind' | 'amountCents' | 'status' | 'stripePaymentIntentId' | 'createdAt' | 'disputedAt'
>;

/**
 * Per-charge remaining refundable balance, newest first. A charge's balance
 * is its amount minus the refunds already attributed to its payment intent;
 * refunds on a shared intent are consumed oldest-charge-first with the
 * remainder carried to the next charge on that intent (never zeroed, which
 * would over-allocate). PENDING refunds consume balance (reserved money is
 * committed to leave); disputed charges have zero balance (Stripe refuses
 * refunds on a disputed charge).
 */
function refundableCharges(
  payments: AllocatablePayment[],
): Array<{ stripePaymentIntentId: string | null; refundableCents: number }> {
  const refundedByIntent = new Map<string | null, number>();
  for (const payment of payments) {
    if (payment.kind !== 'refund') continue;
    if (payment.status !== 'succeeded' && payment.status !== 'pending') continue;
    const key = payment.stripePaymentIntentId ?? null;
    refundedByIntent.set(key, (refundedByIntent.get(key) ?? 0) + payment.amountCents);
  }

  // Attribute the intent's refunds oldest charge first, so the NEWEST
  // charges keep the balance (they are refunded first below).
  const charges = payments
    .filter((payment) => payment.kind === 'charge' && payment.status === 'succeeded')
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .map((charge) => {
      const intentId = charge.stripePaymentIntentId ?? null;
      const owed = refundedByIntent.get(intentId) ?? 0;
      const consumed = Math.min(owed, charge.amountCents);
      refundedByIntent.set(intentId, owed - consumed);
      return {
        stripePaymentIntentId: intentId,
        refundableCents: charge.disputedAt ? 0 : charge.amountCents - consumed,
      };
    });

  return charges.reverse(); // newest first
}

/** Total balance that can still be refunded (excludes disputed charges). */
export function computeRefundableCents(payments: AllocatablePayment[]): number {
  return refundableCharges(payments).reduce((sum, charge) => sum + charge.refundableCents, 0);
}

/**
 * Allocate a refund across succeeded charges, newest first, each capped at
 * that charge's remaining refundable balance. PENDING refunds consume
 * balance too: they are reserved rows written before Stripe runs, and
 * counting them is what makes two concurrent money paths fail closed
 * instead of both refunding the same charge. Disputed charges are skipped
 * entirely (financial freeze). Fails closed when the requested refund
 * exceeds the total refundable balance.
 */
export function allocateRefund(
  payments: AllocatablePayment[],
  refundCents: number,
): RefundAllocation[] {
  if (refundCents <= 0) return [];

  const allocations: RefundAllocation[] = [];
  let remaining = refundCents;

  for (const charge of refundableCharges(payments)) {
    if (remaining === 0) break;
    if (charge.refundableCents <= 0) continue;
    const amount = Math.min(charge.refundableCents, remaining);
    allocations.push({ stripePaymentIntentId: charge.stripePaymentIntentId, amountCents: amount });
    remaining -= amount;
  }

  if (remaining > 0) throw new InsufficientRefundableBalanceError();
  return allocations;
}
