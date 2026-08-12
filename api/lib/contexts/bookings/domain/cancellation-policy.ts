import { computeNetPaidCents } from '@/lib/kernel';
import { computeTotalCents } from './slots';

// The net-paid and refund-allocation math lives in the kernel
// (lib/kernel/payment-allocation.ts): it is the ONE implementation shared
// with the billing context. This module keeps only the booking-specific
// refund POLICY and re-exports the shared math for in-context callers.
export {
  computeNetPaidCents,
  computeRefundableCents,
  allocateRefund,
  type RefundAllocation,
} from '@/lib/kernel';

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
