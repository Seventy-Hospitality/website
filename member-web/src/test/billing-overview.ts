import type { BillingOverview, MembershipSummary } from '../lib/api';

/**
 * Test helper: the GET /api/me/billing overview with only the membership
 * populated. W6 widened getMyMembership to the full BillingOverview; the
 * gate/wizard tests only care about the membership half.
 */
export function billingOverview(membership: MembershipSummary | null): BillingOverview {
  return { membership, defaultPaymentMethod: null, paymentMethods: [], months: [] };
}
