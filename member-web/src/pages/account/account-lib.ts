/**
 * Pure display mappers for the account flow (package W6): profile labels,
 * billing month/date labels, transaction rendering, and the membership
 * status line on the billing card.
 */
import type { BillingTransaction, MembershipSummary } from '../../lib/api';
import { formatAmount, formatAmountWithCents } from '../../lib/plan-pricing';

/** "Member since Mar 2025" (profile subtitle) from the memberSince instant. */
export function memberSinceLabel(memberSinceIso: string): string {
  const date = new Date(memberSinceIso);
  return `Member since ${date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
}

/** Stat-tile hours: whole numbers bare ("888"), halves kept ("1.5"). */
export function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 10) / 10);
}

/** "July 2026" from a venue-local "YYYY-MM" ledger month key. */
export function billingMonthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  // Anchor mid-month UTC so no timezone can shift the label across months.
  const date = new Date(Date.UTC(year, monthNumber - 1, 15));
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "Mar 12, 2027" for an ISO instant (renewal, transaction, effective dates). */
export function instantDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "09/27" from the stored card expiry. */
export function cardExpiryLabel(expMonth: number, expYear: number): string {
  return `${String(expMonth).padStart(2, '0')}/${String(expYear % 100).padStart(2, '0')}`;
}

/** "5 transactions · $192" (month subtitle; net = what the member paid). */
export function billingMonthSummary(count: number, netCents: number): string {
  const noun = count === 1 ? 'transaction' : 'transactions';
  const net = netCents < 0 ? `-${formatAmount(-netCents)}` : formatAmount(netCents);
  return `${count} ${noun} · ${net}`;
}

/** Signed row amount: debits as paid ("$18.00"), credits as money back ("-$18.00"). */
export function transactionAmountLabel(txn: Pick<BillingTransaction, 'direction' | 'amountCents'>): string {
  const amount = formatAmountWithCents(txn.amountCents);
  return txn.direction === 'credit' ? `-${amount}` : amount;
}

/**
 * The status sentence under the plan name on the billing card. The backend
 * does not expose a membership start date ("Active since" in the Figma),
 * so the line reports the state that matters: what happens next.
 */
export function membershipStatusLine(
  membership: Pick<
    MembershipSummary,
    'status' | 'currentPeriodEnd' | 'cancelAtPeriodEnd' | 'pendingPlan' | 'pendingPlanEffectiveAt'
  >,
): string {
  const periodEnd = instantDateLabel(membership.currentPeriodEnd);
  switch (membership.status) {
    case 'active':
    case 'trialing': {
      if (membership.cancelAtPeriodEnd) return `Ends ${periodEnd}`;
      if (membership.pendingPlan) {
        const effective = membership.pendingPlanEffectiveAt
          ? instantDateLabel(membership.pendingPlanEffectiveAt)
          : periodEnd;
        return `Switches to ${membership.pendingPlan.name} on ${effective}`;
      }
      return `Renews ${periodEnd}`;
    }
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
  }
}

/** True when the membership can be self-served through /membership/change
    (the backend's active-member policy). */
export function canChangeMembership(membership: Pick<MembershipSummary, 'status'> | null): boolean {
  return membership !== null && (membership.status === 'active' || membership.status === 'trialing');
}
