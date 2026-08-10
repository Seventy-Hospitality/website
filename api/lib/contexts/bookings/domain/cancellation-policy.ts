import type { ReservationPayment } from './reservation';
import { InsufficientRefundableBalanceError } from './errors';
import { computeTotalCents } from './slots';

/**
 * Cancellation refund tiers (settled product decision 2):
 *   more than 24h before start  -> 100%
 *   2h to 24h before start      ->  50%
 *   inside 2h (or after start)  ->   0%
 * Cancellation itself is always allowed until the reservation starts; the
 * tier only governs the refund. Refunds go to the card on file.
 */
export function refundPercentFor(startsAt: Date, now: Date): number {
  const minutesBefore = (startsAt.getTime() - now.getTime()) / 60_000;
  if (minutesBefore > 24 * 60) return 100;
  if (minutesBefore >= 2 * 60) return 50;
  return 0;
}

/**
 * Net money captured for a reservation: succeeded charges minus refunds.
 * Refunds count while still PENDING: refunds are reserved in the mutating
 * transaction before Stripe runs, and a reserved refund is money already
 * committed to leave, so every concurrent money path must treat it as gone
 * (fail closed). Charges count only once actually captured.
 */
export function computeNetPaidCents(
  payments: Array<Pick<ReservationPayment, 'kind' | 'amountCents' | 'status'>>,
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

export function computeRefundCents(netPaidCents: number, percent: number): number {
  return Math.floor((netPaidCents * percent) / 100);
}

/**
 * Reschedule money delta at the snapshot rate: positive means a new charge,
 * negative a refund of the difference.
 */
export function computeRescheduleDeltaCents(
  newDurationMinutes: number,
  hourlyRateCentsSnapshot: number,
  netPaidCents: number,
): number {
  return computeTotalCents(hourlyRateCentsSnapshot, newDurationMinutes) - netPaidCents;
}

export interface RefundAllocation {
  stripePaymentIntentId: string | null;
  amountCents: number;
}

/**
 * Allocate a refund across succeeded charges, newest first, each capped at
 * that charge's remaining refundable balance (charge minus refunds already
 * attributed to its payment intent). PENDING refunds consume balance too:
 * they are reserved rows written before Stripe runs, and counting them is
 * what makes two concurrent money paths fail closed instead of both
 * refunding the same charge. Fails closed when the requested refund exceeds
 * the total refundable balance.
 */
export function allocateRefund(
  payments: Array<Pick<ReservationPayment, 'kind' | 'amountCents' | 'status' | 'stripePaymentIntentId' | 'createdAt'>>,
  refundCents: number,
): RefundAllocation[] {
  if (refundCents <= 0) return [];

  const refundedByIntent = new Map<string | null, number>();
  for (const payment of payments) {
    if (payment.kind !== 'refund') continue;
    if (payment.status !== 'succeeded' && payment.status !== 'pending') continue;
    const key = payment.stripePaymentIntentId;
    refundedByIntent.set(key, (refundedByIntent.get(key) ?? 0) + payment.amountCents);
  }

  const charges = payments
    .filter((payment) => payment.kind === 'charge' && payment.status === 'succeeded')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const allocations: RefundAllocation[] = [];
  let remaining = refundCents;

  for (const charge of charges) {
    if (remaining === 0) break;
    const alreadyRefunded = refundedByIntent.get(charge.stripePaymentIntentId) ?? 0;
    refundedByIntent.set(charge.stripePaymentIntentId, 0); // consumed against this charge
    const refundable = charge.amountCents - alreadyRefunded;
    if (refundable <= 0) continue;

    const amount = Math.min(refundable, remaining);
    allocations.push({ stripePaymentIntentId: charge.stripePaymentIntentId, amountCents: amount });
    remaining -= amount;
  }

  if (remaining > 0) throw new InsufficientRefundableBalanceError();
  return allocations;
}
