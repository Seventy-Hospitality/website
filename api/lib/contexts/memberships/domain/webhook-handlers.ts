import type { MembershipStatus } from './membership';

/**
 * A fresh read of a Stripe subscription, produced by the billing gateway.
 * Subscription-shaped webhook events are TRIGGERS: the handler re-fetches
 * the subscription and applies this snapshot, so out-of-order deliveries
 * can never write stale state (the fetch-time guard orders concurrent
 * appliers; see MembershipRepository.applySnapshot).
 */
export interface SubscriptionSnapshot {
  subscriptionId: string;
  status: MembershipStatus;
  /** Stripe's verbatim status; differs from `status` only when unrecognized. */
  rawStatus: string;
  statusRecognized: boolean;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  priceId: string | null;
  customerId: string | null;
  /** From subscription metadata, when our subscribe flow created it. */
  memberId: string | null;
  /** Attached subscription schedule (pending downgrade), if any. */
  scheduleId: string | null;
  /**
   * When this snapshot was read from Stripe (the response's own Date header
   * when available, so multi-instance clock skew cannot reorder appliers).
   */
  fetchedAt: Date;
}

export type SubscriptionApplyDecision =
  | { action: 'apply' }
  /** No local row and the subscription is dead: never resurrect it. */
  | { action: 'skip_dead' }
  /** The price is not in membership_plans: alert loudly, apply nothing. */
  | { action: 'skip_unknown_plan' }
  /** No member can be resolved for the subscription: alert, apply nothing. */
  | { action: 'skip_no_member' };

/**
 * Decides what applying a snapshot means. Pure; the repository's guarded
 * upsert (fetch-time ordering + no exit from `canceled`) does the racing.
 */
export function resolveSubscriptionApply(context: {
  snapshot: Pick<SubscriptionSnapshot, 'status'>;
  hasExistingRow: boolean;
  planId: string | null;
  memberId: string | null;
}): SubscriptionApplyDecision {
  if (!context.planId) return { action: 'skip_unknown_plan' };
  if (!context.hasExistingRow) {
    if (context.snapshot.status === 'canceled' || context.snapshot.status === 'incomplete_expired') {
      return { action: 'skip_dead' };
    }
    if (!context.memberId) return { action: 'skip_no_member' };
  }
  return { action: 'apply' };
}
