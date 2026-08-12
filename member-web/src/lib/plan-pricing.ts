/**
 * Pure pricing/grouping logic for the plan-selection screen (package W1).
 *
 * GET /api/plans returns one row per billing period ("Member monthly",
 * "Member annual", "PRO annual", ...). The screen shows a billing-period
 * toggle and one card per tier, re-priced from the row that matches the
 * selected period. Only what the API returns is rendered: a single-period
 * catalog gets no toggle, and a tier without a row for the selected period
 * falls back to its own cheapest row (e.g. the invite-only Pro card keeps
 * showing its annual price while "Pay monthly" is selected).
 */
import type { BillingInterval, Plan } from './api';

const PERIOD_ORDER: readonly BillingInterval[] = ['month', 'year'];

export const PERIOD_LABELS: Record<BillingInterval, string> = {
  month: 'Pay monthly',
  year: 'Pay annually',
};

/**
 * Billing periods offered by the catalog, month before year. Only
 * self-servable rows count: an invite-only-only period would produce a
 * toggle that changes nothing selectable.
 */
export function listBillingPeriods(plans: Plan[]): BillingInterval[] {
  const selectable = plans.filter((plan) => !plan.inviteOnly);
  const source = selectable.length > 0 ? selectable : plans;
  const present = new Set(source.map((plan) => plan.interval));
  return PERIOD_ORDER.filter((period) => present.has(period));
}

/** The default toggle position: annual when offered (the Figma default). */
export function defaultBillingPeriod(plans: Plan[]): BillingInterval {
  const periods = listBillingPeriods(plans);
  if (periods.includes('year')) return 'year';
  return periods[0] ?? 'year';
}

export interface PlanCard {
  tier: string;
  /** The row backing the card for the selected period (or its fallback). */
  plan: Plan;
  /** False when the tier has no row for the selected period (price shown as-is). */
  matchesPeriod: boolean;
  /** Invite-only tiers render locked and cannot be selected. */
  locked: boolean;
}

/**
 * One card per tier for the selected billing period, in catalog sortOrder.
 * A tier's card is backed by its row for the period when one exists,
 * otherwise by its lowest-sortOrder row.
 */
export function planCardsForPeriod(plans: Plan[], period: BillingInterval): PlanCard[] {
  const byTier = new Map<string, Plan[]>();
  for (const plan of plans) {
    const rows = byTier.get(plan.tier) ?? [];
    rows.push(plan);
    byTier.set(plan.tier, rows);
  }

  const cards: PlanCard[] = [];
  for (const rows of byTier.values()) {
    const sorted = [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
    const match = sorted.find((plan) => plan.interval === period);
    const plan = match ?? sorted[0];
    cards.push({
      tier: plan.tier,
      plan,
      matchesPeriod: match !== undefined,
      // A tier is locked when it cannot be self-served at all.
      locked: rows.every((row) => row.inviteOnly),
    });
  }

  return cards.sort((a, b) => a.plan.sortOrder - b.plan.sortOrder);
}

/** "$240" for whole dollars, "$52.50" otherwise (the plan card headline). */
export function formatAmount(amountCents: number): string {
  const dollars = amountCents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : formatAmountWithCents(amountCents);
}

/** Always two decimals: the checkout order summary ("$240.00"). */
export function formatAmountWithCents(amountCents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    amountCents / 100,
  );
}

/** "/ year" next to the headline price. */
export function periodSuffix(interval: BillingInterval): string {
  return interval === 'year' ? '/ year' : '/ month';
}

/**
 * The caption under the headline price: annual plans advertise their
 * monthly equivalent ("$20 per month, billed annually."), monthly plans
 * state their cadence.
 */
export function billingCaption(plan: Pick<Plan, 'amountCents' | 'interval'>): string {
  if (plan.interval === 'year') {
    return `${formatAmount(Math.round(plan.amountCents / 12))} per month, billed annually.`;
  }
  return 'Billed monthly.';
}
