import { monthRangeUtc, monthTotals, type BillingTransaction, type MonthBucket } from '../domain';
import type { TransactionRepository } from '../infrastructure/transaction.repository';
import type { PaymentMethodRepository, PaymentMethodRecord } from '../infrastructure/payment-method.repository';
import type { StripeGateway } from '../infrastructure/stripe.gateway';
import type { BookingSettlementPort, MemberBillingDirectory, MembershipBillingLookup } from './ports';

export interface BillingOverview {
  defaultPaymentMethod: PaymentMethodRecord | null;
  months: MonthBucket[];
}

export class AccountClosureBlockedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Account closure blocked: ${reasons.join(', ')}`);
    this.name = 'AccountClosureBlockedError';
  }
}

/**
 * Member-facing billing reads (always the LOCAL ledger, never a live
 * Stripe fan-out) and the billing-side account-closure operations that
 * package E's deletion pipeline will orchestrate.
 */
export class BillingService {
  constructor(
    private readonly ledger: TransactionRepository,
    private readonly paymentMethods: PaymentMethodRepository,
    private readonly gateway: StripeGateway,
    private readonly members: MemberBillingDirectory,
    private readonly membershipLookup: MembershipBillingLookup,
    private readonly bookings: BookingSettlementPort,
    private readonly timezone: string,
  ) {}

  /** Month buckets (venue-timezone grouping) + the default card. */
  async getOverview(memberId: string): Promise<BillingOverview> {
    const [rows, defaultPaymentMethod] = await Promise.all([
      this.ledger.listRowsForTotals(memberId),
      this.paymentMethods.getDefaultForMember(memberId),
    ]);
    return { defaultPaymentMethod, months: monthTotals(rows, this.timezone) };
  }

  /** One venue-local month's rows ("YYYY-MM"), newest first. */
  async getTransactionsForMonth(memberId: string, month: string): Promise<BillingTransaction[]> {
    const { from, to } = monthRangeUtc(month, this.timezone);
    return this.ledger.listForMemberBetween(memberId, from, to);
  }

  // ── Account closure (the billing side of package E's deletion pipeline) ──

  /**
   * TODO(package-e): the deletion pipeline (step-up re-auth, session
   * revocation, reservation cancellation, member anonymization) lives in
   * the account package; it calls these two methods for the billing side.
   *
   * Blocked while money is unsettled: a refund in flight or an open
   * dispute must resolve before the member can be deleted.
   */
  async assertClosable(memberId: string): Promise<void> {
    const reasons: string[] = [];
    if (await this.bookings.hasBlockingFinancialState(memberId)) {
      reasons.push('a refund in flight or an open dispute');
    }
    if ((await this.ledger.countPendingForMember(memberId)) > 0) {
      reasons.push('pending ledger transactions');
    }
    if (reasons.length > 0) throw new AccountClosureBlockedError(reasons);
  }

  /**
   * Close the billing side: cancel the subscription (immediately; the
   * account is going away), detach every payment method, tag the Stripe
   * customer. NEVER customers.del() (irreversible, kills chargeback
   * defense); the ledger and stripeCustomerId are kept (retention +
   * dispute windows), and a re-signup mints a fresh customer.
   */
  async closeBillingForMember(memberId: string, now: Date = new Date()): Promise<{
    subscriptionCanceled: boolean;
    paymentMethodsDetached: number;
  }> {
    await this.assertClosable(memberId);

    let subscriptionCanceled = false;
    const membership = await this.membershipLookup.getCurrentForMember(memberId);
    if (membership && membership.status !== 'canceled' && membership.status !== 'incomplete_expired') {
      if (membership.stripeScheduleId) await this.gateway.releaseSchedule(membership.stripeScheduleId);
      await this.gateway.cancelSubscriptionNow(membership.stripeSubscriptionId);
      subscriptionCanceled = true;
    }

    const member = await this.members.getById(memberId);
    let paymentMethodsDetached = 0;
    if (member?.stripeCustomerId) {
      for (const pm of await this.gateway.listCustomerPaymentMethods(member.stripeCustomerId)) {
        await this.gateway.detachPaymentMethod(pm.paymentMethodId);
        paymentMethodsDetached += 1;
      }
      await this.gateway.tagCustomerDeleted(member.stripeCustomerId, now);
    }
    await this.paymentMethods.deleteAllForMember(memberId);

    return { subscriptionCanceled, paymentMethodsDetached };
  }
}
