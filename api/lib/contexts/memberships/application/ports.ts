import type { SubscriptionSnapshot } from '../domain';

/**
 * The narrow seam to Stripe's subscription machinery. Implemented by the
 * billing context's StripeGateway: memberships owns subscription STATE and
 * lifecycle decisions; billing owns the Stripe SDK.
 */
export interface SubscriptionGateway {
  createCustomer(email: string, name: string, memberId: string): Promise<string>;

  /**
   * Subscription-first purchase (settled design): default_incomplete +
   * save_default_payment_method on_subscription; the returned client secret
   * is latest_invoice.confirmation_secret for PaymentSheet.
   */
  createIncompleteSubscription(input: {
    customerId: string;
    priceId: string;
    memberId: string;
    planId: string;
    termsVersion: string;
  }): Promise<{ snapshot: SubscriptionSnapshot; clientSecret: string | null }>;

  /** Fresh confirmation secret for re-entering an incomplete purchase. */
  getConfirmationSecret(subscriptionId: string): Promise<string | null>;

  /** Fresh subscription state; null when Stripe no longer knows the id. */
  getSubscriptionState(subscriptionId: string): Promise<SubscriptionSnapshot | null>;

  /**
   * Immediate plan change with prorations (upgrades). May need SCA on the
   * proration invoice; the confirmation secret comes back when it exists.
   */
  changeSubscriptionPrice(
    subscriptionId: string,
    priceId: string,
  ): Promise<{ snapshot: SubscriptionSnapshot; clientSecret: string | null }>;

  /**
   * Downgrade at period end via a transient subscription schedule (phase 2 =
   * the cheaper price, one iteration, auto-releases). No proration, no
   * refund, current period untouched.
   */
  scheduleDowngrade(
    subscriptionId: string,
    priceId: string,
    interval: 'month' | 'year',
  ): Promise<{ scheduleId: string; effectiveAt: Date }>;

  /** Detach a schedule, leaving the subscription in place. */
  releaseSchedule(scheduleId: string): Promise<void>;

  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<SubscriptionSnapshot>;
  cancelSubscriptionNow(subscriptionId: string): Promise<SubscriptionSnapshot>;

  /** Every subscription on the account (drift sweep), freshly snapshotted. */
  listAllSubscriptions(): Promise<SubscriptionSnapshot[]>;

  /** PaymentSheet needs an ephemeral key minted at the MOBILE API version. */
  createEphemeralKey(customerId: string): Promise<string>;

  // Legacy admin flows (Checkout redirect + Billing Portal).
  createCheckoutSession(
    customerId: string,
    priceId: string,
    memberId: string,
    planId: string,
  ): Promise<string>;
  createPortalSession(customerId: string): Promise<string>;
}

/** Terms acceptance is recorded on the user row (identity context owns it). */
export interface TermsRecorder {
  recordAcceptance(userId: string, version: string, when: Date): Promise<void>;
}

/** Member resolution for webhook-driven subscription adoption. */
export interface MemberAccountLookup {
  findByStripeCustomerId(stripeCustomerId: string): Promise<{ id: string } | null>;
}
