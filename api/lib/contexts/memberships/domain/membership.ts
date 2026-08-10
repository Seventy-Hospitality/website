// ── State ──

export interface Membership {
  id: string;
  memberId: string;
  planId: string;
  stripeSubscriptionId: string;
  status: MembershipStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** Pending annual->monthly downgrade (transient Stripe schedule). */
  stripeScheduleId: string | null;
  pendingPlanId: string | null;
  pendingPlanEffectiveAt: Date | null;
  /** Fetch-time ordering guard for webhook re-fetch-and-apply. */
  stripeFetchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Stripe's subscription statuses, stored verbatim. The product sells no
 * trials, but a dashboard-created trial must not lock a paying member out,
 * so `trialing` counts as entitled.
 */
export type MembershipStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

const KNOWN_STATUSES: ReadonlySet<string> = new Set<MembershipStatus>([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
]);

/** Statuses that grant membership entitlements. */
export const ENTITLED_STATUSES: readonly MembershipStatus[] = ['active', 'trialing'];

export function isEntitledStatus(status: string): boolean {
  return status === 'active' || status === 'trialing';
}

/**
 * Exhaustive status mapping, never an unchecked cast: an unrecognized
 * status (a future Stripe addition) maps to `unpaid` (fail closed, no
 * entitlements) and is flagged so the caller alerts instead of shrugging.
 */
export function normalizeSubscriptionStatus(raw: string): {
  status: MembershipStatus;
  recognized: boolean;
} {
  if (KNOWN_STATUSES.has(raw)) return { status: raw as MembershipStatus, recognized: true };
  return { status: 'unpaid', recognized: false };
}

/**
 * "The member's current membership" is a query, not a unique row: a member
 * can hold several subscription rows over time (re-subscribing is a new
 * Stripe subscription id) and, transiently, in parallel. Preference order:
 * entitled > operative-but-delinquent > mid-purchase > dead, latest period
 * end within a rank.
 */
const STATUS_RANK: Record<MembershipStatus, number> = {
  active: 0,
  trialing: 0,
  past_due: 1,
  unpaid: 2,
  paused: 2,
  incomplete: 3,
  canceled: 4,
  incomplete_expired: 5,
};

export function pickCurrentMembership<T extends { status: string; currentPeriodEnd: Date }>(
  rows: T[],
): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const rankA = STATUS_RANK[a.status as MembershipStatus] ?? 2;
    const rankB = STATUS_RANK[b.status as MembershipStatus] ?? 2;
    if (rankA !== rankB) return rankA - rankB;
    return b.currentPeriodEnd.getTime() - a.currentPeriodEnd.getTime();
  })[0];
}

export interface Plan {
  id: string;
  name: string;
  stripePriceId: string;
  stripeProductId: string;
  amountCents: number;
  interval: 'month' | 'year';
  tier: 'member' | 'pro';
  inviteOnly: boolean;
  features: string[];
  sortOrder: number;
  active: boolean;
}

/**
 * Plan-change direction (settled policy): upgrades apply immediately with
 * prorations, downgrades take effect at period end with no refund. A change
 * is an upgrade when it raises the tier, or lengthens the interval at the
 * same tier (monthly -> annual), or raises the price at the same tier and
 * interval.
 */
export function isPlanUpgrade(current: Plan, target: Plan): boolean {
  const tierRank = (plan: Plan) => (plan.tier === 'pro' ? 1 : 0);
  if (tierRank(target) !== tierRank(current)) return tierRank(target) > tierRank(current);
  if (target.interval !== current.interval) return target.interval === 'year';
  return target.amountCents > current.amountCents;
}

// ── Domain rules ──

export const membershipInvariants = {
  /** Cannot start a subscription while one is entitled or collecting. */
  canStartSubscription(currentMembership: Pick<Membership, 'status'> | null): void {
    if (
      currentMembership &&
      (isEntitledStatus(currentMembership.status) || currentMembership.status === 'past_due')
    ) {
      throw new MembershipError('Member already has an active subscription');
    }
  },

  /** Cannot access billing portal without a Stripe customer */
  requiresStripeCustomer(stripeCustomerId: string | null): void {
    if (!stripeCustomerId) {
      throw new MembershipError('Member has no Stripe customer. Start a subscription first.');
    }
  },
};

// ── Errors ──

export class MembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MembershipError';
  }
}

export class PlanNotFoundError extends Error {
  constructor(id: string) {
    super(`Membership plan not found: ${id}`);
    this.name = 'PlanNotFoundError';
  }
}

export class PlanInviteOnlyError extends Error {
  constructor() {
    super('This plan is invite-only');
    this.name = 'PlanInviteOnlyError';
  }
}

export class NoMembershipError extends Error {
  constructor() {
    super('No membership found for this member');
    this.name = 'NoMembershipError';
  }
}
