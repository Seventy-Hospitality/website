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

/** Net money captured for a reservation: succeeded charges minus succeeded refunds. */
export function computeNetPaidCents(
  payments: Array<Pick<ReservationPayment, 'kind' | 'amountCents' | 'status'>>,
): number {
  return payments.reduce((net, payment) => {
    if (payment.status !== 'succeeded') return net;
    return payment.kind === 'charge' ? net + payment.amountCents : net - payment.amountCents;
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
 * attributed to its payment intent). Fails closed when the requested refund
 * exceeds the total refundable balance.
 */
export function allocateRefund(
  payments: Array<Pick<ReservationPayment, 'kind' | 'amountCents' | 'status' | 'stripePaymentIntentId' | 'createdAt'>>,
  refundCents: number,
): RefundAllocation[] {
  if (refundCents <= 0) return [];

  const succeeded = payments.filter((payment) => payment.status === 'succeeded');
  const refundedByIntent = new Map<string | null, number>();
  for (const payment of succeeded) {
    if (payment.kind !== 'refund') continue;
    const key = payment.stripePaymentIntentId;
    refundedByIntent.set(key, (refundedByIntent.get(key) ?? 0) + payment.amountCents);
  }

  const charges = succeeded
    .filter((payment) => payment.kind === 'charge')
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
