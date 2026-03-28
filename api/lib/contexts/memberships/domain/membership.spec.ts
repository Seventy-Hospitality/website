import { membershipInvariants, MembershipError } from './membership';
import type { Membership } from './membership';

function makeMembership(overrides: Partial<Membership> = {}): Membership {
  return {
    id: 'mem_1',
    memberId: 'mbr_1',
    planId: 'plan_1',
    stripeSubscriptionId: 'sub_1',
    status: 'active',
    currentPeriodEnd: new Date('2025-12-31'),
    cancelAtPeriodEnd: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('membershipInvariants', () => {
  describe('canStartSubscription', () => {
    it('allows when no current membership', () => {
      expect(() => membershipInvariants.canStartSubscription(null)).not.toThrow();
    });

    it('allows when current membership is canceled', () => {
      expect(() =>
        membershipInvariants.canStartSubscription(makeMembership({ status: 'canceled' }))
      ).not.toThrow();
    });

    it('allows when current membership is past_due', () => {
      expect(() =>
        membershipInvariants.canStartSubscription(makeMembership({ status: 'past_due' }))
      ).not.toThrow();
    });

    it('blocks when current membership is active', () => {
      expect(() =>
        membershipInvariants.canStartSubscription(makeMembership({ status: 'active' }))
      ).toThrow(MembershipError);
    });
  });

  describe('requiresStripeCustomer', () => {
    it('passes with a customer ID', () => {
      expect(() => membershipInvariants.requiresStripeCustomer('cus_123')).not.toThrow();
    });

    it('throws without a customer ID', () => {
      expect(() => membershipInvariants.requiresStripeCustomer(null)).toThrow(MembershipError);
    });
  });
});
