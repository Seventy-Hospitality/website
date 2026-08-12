/**
 * Pure presentation + gating helpers for the mobile account surface (M6).
 * Ported 1:1 from member-web (src/pages/account/account-lib.ts and
 * src/lib/membership-change.ts) so the two clients label money, dates,
 * membership status, and plan-change direction identically. Framework-free so
 * the proration direction, the self-serve gates, and the formatters are
 * unit-tested in isolation.
 */
import type {
  BillingInterval,
  BillingTransaction,
  MembershipStatus,
  MembershipSummary,
  TransactionStatus,
} from '../../lib/api';

// Reuse M1's pricing/grouping helpers so the plan cards on the change screen
// price memberships exactly like onboarding.
export {
  formatAmount,
  formatAmountWithCents,
  periodSuffix,
  billingCaption,
  listBillingPeriods,
  defaultBillingPeriod,
  planCardsForPeriod,
  tierLabel,
  PERIOD_LABELS,
  type PlanCard,
} from '../onboarding/plan-pricing';
import { formatAmount, formatAmountWithCents } from '../onboarding/plan-pricing';

// ── Member identity ──

/** The custom display name, or the "First Last" fallback (matches the API). */
export function memberDisplayName(member: {
  displayName: string | null;
  firstName: string;
  lastName: string;
}): string {
  const custom = member.displayName?.trim();
  if (custom) return custom;
  return `${member.firstName} ${member.lastName}`.trim();
}

/** "#U00578" for the member-number line. */
export function memberNumberLabel(memberNumber: string): string {
  return `#${memberNumber}`;
}

/** "Member since Mar 2025" (rendered in the venue timezone). */
export function memberSinceLabel(memberSinceIso: string, timezone: string): string {
  const label = new Date(memberSinceIso).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  });
  return `Member since ${label}`;
}

/** Whole hours as-is, otherwise one decimal ("888", "1.5"). */
export function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 10) / 10);
}

// ── Dates / cards ──

/** "Mar 12, 2027" (venue timezone). */
export function instantDateLabel(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone,
  });
}

/** "09/27" from exp month + year. */
export function cardExpiryLabel(expMonth: number, expYear: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(expMonth)}/${pad(expYear % 100)}`;
}

/** "VISA •••• 4242 · exp 09/27" for the payment-method row. */
export function paymentMethodLabel(pm: {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}): string {
  return `•••• ${pm.last4} · exp ${cardExpiryLabel(pm.expMonth, pm.expYear)}`;
}

// ── Billing history ──

/** "July 2026" from "YYYY-MM" (anchored mid-month in UTC to avoid tz drift). */
export function billingMonthLabel(month: string): string {
  const [year, m] = month.split('-').map((part) => Number(part));
  if (!year || !m) return month;
  return new Date(Date.UTC(year, m - 1, 15)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "5 transactions · $192" (net; a net credit shows "-$18"). */
export function billingMonthSummary(count: number, netCents: number): string {
  const noun = count === 1 ? 'transaction' : 'transactions';
  const money = netCents < 0 ? `-${formatAmount(-netCents)}` : formatAmount(netCents);
  return `${count} ${noun} · ${money}`;
}

/** Credits render as a negative "money back" amount; debits positive. */
export function transactionAmountLabel(
  txn: Pick<BillingTransaction, 'direction' | 'amountCents'>,
): string {
  return txn.direction === 'credit'
    ? `-${formatAmountWithCents(txn.amountCents)}`
    : formatAmountWithCents(txn.amountCents);
}

/** Row status caption; a succeeded transaction shows none. */
export const TXN_STATUS_LABELS: Record<TransactionStatus, string | null> = {
  succeeded: null,
  pending: 'Pending',
  failed: 'Failed',
  canceled: 'Canceled',
};

// ── Membership status + gates ──

/** "/yr" or "/mo" next to the billing-card price. */
export function membershipPriceSuffix(interval: BillingInterval): string {
  return interval === 'year' ? '/yr' : '/mo';
}

/**
 * The forward-looking status sentence under the plan on the billing card.
 * Ported from member-web; the backend exposes no membership start date, so
 * this reports what happens next (renews / ends / switches / past due) rather
 * than an "active since" date.
 */
export function membershipStatusLine(membership: MembershipSummary, timezone: string): string {
  const periodEnd = instantDateLabel(membership.currentPeriodEnd, timezone);
  switch (membership.status) {
    case 'active':
    case 'trialing':
      if (membership.cancelAtPeriodEnd) return `Ends ${periodEnd}`;
      if (membership.pendingPlan) {
        const effective = membership.pendingPlanEffectiveAt
          ? instantDateLabel(membership.pendingPlanEffectiveAt, timezone)
          : periodEnd;
        return `Switches to ${membership.pendingPlan.name} on ${effective}`;
      }
      return `Renews ${periodEnd}`;
    case 'past_due':
    case 'unpaid':
      return 'Payment past due';
    case 'paused':
      return 'Paused';
    case 'incomplete':
    case 'incomplete_expired':
      return 'Payment incomplete';
    case 'canceled':
      return `Ended ${periodEnd}`;
    default:
      return '';
  }
}

/** Plan changes need a live-and-current membership (backend `active-member`). */
export function canChangeMembership(membership: MembershipSummary | null): boolean {
  return membership !== null && (membership.status === 'active' || membership.status === 'trialing');
}

/**
 * Cancel is allowed for any live subscription, including past_due / unpaid /
 * paused, so a member is never trapped (backend `member`). Only a terminal
 * membership cannot be cancelled.
 */
export function canCancelMembership(membership: MembershipSummary | null): boolean {
  return (
    membership !== null &&
    membership.status !== 'canceled' &&
    membership.status !== 'incomplete_expired'
  );
}

// ── Delete-account blocked reasons ──

/** "a" / "a and b" / "a, b and c" for the deletion-blocked message. */
export function formatReasons(reasons: string[]): string {
  if (reasons.length === 0) return '';
  if (reasons.length === 1) return reasons[0];
  return `${reasons.slice(0, -1).join(', ')} and ${reasons[reasons.length - 1]}`;
}

// ── Plan-change direction (proration preview copy + button label) ──

export interface ChangeablePlan {
  tier: string;
  interval: BillingInterval;
  amountCents: number;
}

/**
 * Client mirror of the backend's upgrade test; drives the preview copy and the
 * button label only (the POST /change response is authoritative). Precedence:
 * (1) tier — `pro` outranks `member`; (2) same tier, interval — month→year is
 * an upgrade; (3) same tier + interval — a higher price is an upgrade.
 */
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

/** The sentence under the plan cards describing when the change takes effect. */
export function planChangeSummary(kind: PlanChangeKind, periodEndLabel: string): string {
  if (kind === 'upgrade') {
    return 'Your new plan starts right away. You will be charged a prorated amount for the rest of the current billing period.';
  }
  return `Your new plan starts on ${periodEndLabel}, when the current billing period ends. You keep your current plan until then; the difference is not refunded.`;
}
