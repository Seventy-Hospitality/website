// Structural ports out of the billing context. The container wires the
// real services (bookings' ReservationService, members' MemberRepository,
// memberships' MembershipService/Repository) onto these narrow shapes, so
// billing's application layer never names another BC's concrete class.

/** What billing needs from the bookings settlement machinery. */
export interface BookingSettlementPort {
  /** payment_intent.succeeded / reconcile: settle a captured intent. */
  handleCapturedPayment(
    reservationId: string,
    options?: { source?: string; intent?: { paymentIntentId: string; amountCents: number } },
  ): Promise<'confirmed' | 'already_settled' | 'orphan_refunded' | 'not_captured'>;
  /** refund.updated / charge.refunded: finalize an async refund outcome. */
  reconcileRefundOutcome(
    stripeRefundId: string,
    outcome: 'succeeded' | 'failed' | 'canceled',
    source?: string,
  ): Promise<'reconciled' | 'unknown'>;
  /** Dashboard-initiated refunds must consume settlement balance too. */
  recordExternalRefund(input: {
    stripeRefundId: string;
    stripePaymentIntentId: string | null;
    amountCents: number;
    status: 'pending' | 'succeeded' | 'failed';
    source?: string;
  }): Promise<'recorded' | 'known' | 'unmatched'>;
  /** charge.dispute.created: freeze the reservation financially. */
  freezeChargeForDispute(stripePaymentIntentId: string, source?: string): Promise<string[]>;
  /** Account-closure blocker: refunds in flight or open disputes. */
  hasBlockingFinancialState(memberId: string): Promise<boolean>;
}

/** Member resolution + Stripe-customer bookkeeping (members context). */
export interface MemberBillingDirectory {
  getById(id: string): Promise<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    stripeCustomerId: string | null;
  } | null>;
  findByStripeCustomerId(stripeCustomerId: string): Promise<{ id: string } | null>;
  setStripeCustomerId(id: string, stripeCustomerId: string): Promise<void>;
}

/** Subscription state application (memberships context). */
export interface MembershipStateApplier {
  applySubscriptionState(
    subscriptionId: string,
    options?: { fallbackMemberId?: string },
  ): Promise<{ applied: boolean; outcome: string }>;
}

/** Membership row lookup for ledger linkage + closure. */
export interface MembershipBillingLookup {
  getByStripeSubscriptionId(
    subscriptionId: string,
  ): Promise<{ id: string; memberId: string; stripeSubscriptionId: string; status: string } | null>;
  getCurrentForMember(memberId: string): Promise<{
    id: string;
    memberId: string;
    stripeSubscriptionId: string;
    status: string;
    stripeScheduleId: string | null;
  } | null>;
}
