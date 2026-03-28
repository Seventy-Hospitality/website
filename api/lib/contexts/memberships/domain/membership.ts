// ── State ──

export interface Membership {
  id: string;
  memberId: string;
  planId: string;
  stripeSubscriptionId: string;
  status: MembershipStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type MembershipStatus = 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete';

export interface Plan {
  id: string;
  name: string;
  stripePriceId: string;
  stripeProductId: string;
  amountCents: number;
  interval: 'month' | 'year';
  active: boolean;
}

// ── Domain rules ──

export const membershipInvariants = {
  /** Cannot start a subscription for a member who already has an active one */
  canStartSubscription(currentMembership: Membership | null): void {
    if (currentMembership && currentMembership.status === 'active') {
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
