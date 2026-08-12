/**
 * Client mirror of the backend's plan-change policy (package W6), kept pure
 * so the change-membership screen can explain what a switch will do BEFORE
 * calling POST /api/me/membership/change. The server response stays
 * authoritative; this only drives the preview copy.
 *
 * Backend source: memberships/domain/membership.ts `isPlanUpgrade` and
 * MembershipService.changePlan: upgrades (tier up, monthly -> annual, or a
 * price raise at the same tier+interval) apply immediately with prorations;
 * everything else is a downgrade scheduled for period end, no refund.
 */
import type { BillingInterval } from './api';

export interface ChangeablePlan {
  id: string;
  tier: string;
  interval: BillingInterval;
  amountCents: number;
}

/** Mirrors the backend's isPlanUpgrade exactly (pro outranks member). */
export function isPlanUpgrade(current: ChangeablePlan, target: ChangeablePlan): boolean {
  const tierRank = (plan: ChangeablePlan) => (plan.tier === 'pro' ? 1 : 0);
  if (tierRank(target) !== tierRank(current)) return tierRank(target) > tierRank(current);
  if (target.interval !== current.interval) return target.interval === 'year';
  return target.amountCents > current.amountCents;
}

export type PlanChangeKind = 'upgrade' | 'downgrade';

export function planChangeKind(current: ChangeablePlan, target: ChangeablePlan): PlanChangeKind {
  return isPlanUpgrade(current, target) ? 'upgrade' : 'downgrade';
}

/**
 * The proration sentence shown above the confirm button. `periodEndLabel`
 * is the already-formatted current period end date.
 */
export function planChangeSummary(kind: PlanChangeKind, periodEndLabel: string): string {
  if (kind === 'upgrade') {
    return 'Your new plan starts right away. You will be charged a prorated amount for the rest of the current billing period.';
  }
  return `Your new plan starts on ${periodEndLabel}, when the current billing period ends. You keep your current plan until then; the difference is not refunded.`;
}
