import {
  bookingChargeLedgerDraft,
  invoiceLedgerDraft,
  ledgerStatusFromRefundStatus,
  refundLedgerDraft,
  type RefundData,
  type StripeEventRef,
} from '../domain';
import type { StripeGateway } from '../infrastructure/stripe.gateway';
import type { TransactionRepository } from '../infrastructure/transaction.repository';
import type { PaymentMethodRepository } from '../infrastructure/payment-method.repository';
import type { WebhookEventRepository } from '../infrastructure/webhook-event.repository';
import type {
  BookingSettlementPort,
  MemberBillingDirectory,
  MembershipBillingLookup,
  MembershipStateApplier,
} from './ports';

export type WebhookOutcome = 'handled' | 'ignored' | 'duplicate';

/**
 * Webhook processing. The route stays thin (signature check + map); this
 * service owns the policy:
 *
 * - processed_webhook_events dedupe: checked first, recorded only AFTER a
 *   successful run, so a failure leaves no tombstone and Stripe's retry
 *   really reprocesses. Handlers are idempotent (guarded upserts, CAS), so
 *   two concurrent duplicates are merely redundant work.
 * - Subscription-shaped events are TRIGGERS: re-fetch and apply fresh state
 *   (fetch-time ordering guard in memberships). Out-of-order deliveries can
 *   never move state backwards or resurrect a canceled membership.
 * - A thrown error propagates: the route answers 500 and Stripe retries.
 *   Permanently unhandleable states (unknown price, unresolvable member)
 *   are alerted and acknowledged instead, so the retry budget is not
 *   burned on events that can never succeed.
 */
export class WebhookService {
  constructor(
    private readonly gateway: StripeGateway,
    private readonly webhookEvents: WebhookEventRepository,
    private readonly ledger: TransactionRepository,
    private readonly paymentMethods: PaymentMethodRepository,
    private readonly memberships: MembershipStateApplier,
    private readonly membershipLookup: MembershipBillingLookup,
    private readonly bookings: BookingSettlementPort,
    private readonly members: MemberBillingDirectory,
  ) {}

  async process(ref: StripeEventRef): Promise<WebhookOutcome> {
    if (ref.kind === 'ignored') return 'ignored';
    if (await this.webhookEvents.wasProcessed(ref.eventId)) return 'duplicate';

    switch (ref.kind) {
      case 'checkout_completed':
        await this.handleCheckoutCompleted(ref);
        break;
      case 'subscription_changed':
        await this.memberships.applySubscriptionState(ref.subscriptionId);
        break;
      case 'invoice_paid':
        await this.handleInvoicePaid(ref);
        break;
      case 'invoice_failed':
        // SCA required or payment failed on a renewal: re-fetched state
        // carries past_due/incomplete; the member surface reads it there.
        // TODO(package-f): notify the member ("your payment failed").
        if (ref.subscriptionId) await this.memberships.applySubscriptionState(ref.subscriptionId);
        break;
      case 'payment_intent_succeeded':
        await this.handlePaymentIntentSucceeded(ref);
        break;
      case 'payment_intent_failed':
        // The intent stays reusable with another card in-sheet; nothing to
        // record (no money moved) and the hold sweeper owns expiry.
        break;
      case 'charge_refunded':
        for (const refund of await this.gateway.listRefundsForCharge(ref.chargeId)) {
          await this.applyRefund(refund, ref.eventId);
        }
        break;
      case 'refund_updated': {
        const refund = await this.gateway.getRefundData(ref.refundId);
        if (refund) await this.applyRefund(refund, ref.eventId);
        break;
      }
      case 'dispute_created':
        await this.handleDisputeCreated(ref);
        break;
      case 'payment_method_attached':
      case 'payment_method_updated':
        await this.upsertPaymentMethodMirror(ref.paymentMethodId);
        break;
      case 'payment_method_detached':
        await this.paymentMethods.deleteByStripeId(ref.paymentMethodId);
        break;
    }

    await this.webhookEvents.markProcessed(ref.eventId, ref.eventType);
    return 'handled';
  }

  // ── Handlers ──

  private async handleCheckoutCompleted(
    ref: Extract<StripeEventRef, { kind: 'checkout_completed' }>,
  ): Promise<void> {
    // Customer-id backstop (may already be set from the checkout route).
    if (ref.customerId && ref.memberId) {
      await this.members.setStripeCustomerId(ref.memberId, ref.customerId).catch(() => {});
    }
    if (ref.subscriptionId) {
      await this.memberships.applySubscriptionState(ref.subscriptionId, {
        fallbackMemberId: ref.memberId ?? undefined,
      });
    }
  }

  private async handleInvoicePaid(
    ref: Extract<StripeEventRef, { kind: 'invoice_paid' }>,
  ): Promise<void> {
    if (ref.subscriptionId) {
      await this.memberships.applySubscriptionState(ref.subscriptionId);
    }

    // Trigger pattern: re-fetch the invoice, never trust the event payload.
    const invoice = await this.gateway.getInvoiceLedgerData(ref.invoiceId);
    if (!invoice) return;

    const membership = invoice.subscriptionId
      ? await this.membershipLookup.getByStripeSubscriptionId(invoice.subscriptionId)
      : null;
    const memberId =
      membership?.memberId ??
      (invoice.customerId
        ? (await this.members.findByStripeCustomerId(invoice.customerId))?.id ?? null
        : null);
    if (!memberId) {
      // Permanently unhandleable for us; alert, do not burn retries.
      console.error(
        `[billing] invoice ${invoice.invoiceId} has no resolvable member (customer ${invoice.customerId}); no ledger row written`,
      );
      return;
    }

    const draft = invoiceLedgerDraft(invoice, memberId, membership?.id ?? null);
    if (draft) await this.ledger.upsertByStripeObject(draft);
  }

  private async handlePaymentIntentSucceeded(
    ref: Extract<StripeEventRef, { kind: 'payment_intent_succeeded' }>,
  ): Promise<void> {
    const settlement = await this.gateway.getPaymentIntentSettlement(ref.paymentIntentId);
    if (!settlement) return;
    if (!settlement.reservationId) {
      // Subscription/invoice money: the invoice.paid path owns its ledger
      // row; an unrelated intent on our account is alerted by reconcile.
      return;
    }

    // Ledger first (a Stripe fact, idempotent), settlement second: if
    // settlement throws (hold row not yet visible), the 500 retry re-runs
    // both and the upsert converges.
    const memberId = await this.resolveMemberId(settlement.memberId, settlement.customerId);
    if (memberId) {
      const draft = bookingChargeLedgerDraft(settlement, memberId);
      if (draft) await this.ledger.upsertByStripeObject(draft);
    }

    await this.bookings.handleCapturedPayment(settlement.reservationId, {
      source: 'webhook',
      intent: {
        paymentIntentId: settlement.paymentIntentId,
        amountCents: settlement.amountReceivedCents,
      },
    });
  }

  private async applyRefund(refund: RefundData, eventId: string): Promise<void> {
    const memberId = await this.resolveMemberId(refund.memberId, refund.customerId);
    if (memberId) {
      await this.ledger.upsertByStripeObject({ ...refundLedgerDraft(refund, memberId), stripeEventId: eventId });
    } else {
      console.error(
        `[billing] refund ${refund.refundId} has no resolvable member; no ledger row written`,
      );
    }

    if (!refund.reservationId && !refund.paymentIntentId) return;

    // Bookings settlement reconciliation: finalize our own refunds
    // (async-failure flips the row back), record dashboard-initiated ones
    // so refundable balance stays truthful.
    const outcome = ledgerStatusFromRefundStatus(refund.status);
    if (outcome !== 'pending') {
      const known = await this.bookings.reconcileRefundOutcome(refund.refundId, outcome, 'webhook');
      if (known === 'unknown') {
        await this.bookings.recordExternalRefund({
          stripeRefundId: refund.refundId,
          stripePaymentIntentId: refund.paymentIntentId,
          amountCents: refund.amountCents,
          status: outcome === 'canceled' ? 'failed' : outcome,
          refundKey: refund.refundKey,
          source: 'webhook',
        });
      }
    } else {
      // Still pending: make sure the settlement record knows it exists. A
      // refund we originated carries refundKey and is ADOPTED onto its
      // reserved row (stamping stripeRefundId), never double-recorded.
      await this.bookings.recordExternalRefund({
        stripeRefundId: refund.refundId,
        stripePaymentIntentId: refund.paymentIntentId,
        amountCents: refund.amountCents,
        status: 'pending',
        refundKey: refund.refundKey,
        source: 'webhook',
      });
    }
  }

  private async handleDisputeCreated(
    ref: Extract<StripeEventRef, { kind: 'dispute_created' }>,
  ): Promise<void> {
    // TODO(package-f): staff notification; a dispute always needs a human.
    console.error(`[billing] dispute opened on charge ${ref.chargeId}; freezing linked reservation`);
    if (ref.paymentIntentId) {
      await this.bookings.freezeChargeForDispute(ref.paymentIntentId, 'webhook');
    }
  }

  private async upsertPaymentMethodMirror(paymentMethodId: string): Promise<void> {
    const pm = await this.gateway.getPaymentMethodData(paymentMethodId);
    if (!pm) {
      // Detached before we processed the attach: mirror must not keep it.
      await this.paymentMethods.deleteByStripeId(paymentMethodId);
      return;
    }
    if (!pm.customerId) return;
    const member = await this.members.findByStripeCustomerId(pm.customerId);
    if (!member) return; // not one of ours (or the mirror lags the member)
    // A payment_method.attached racing account closure must not resurrect
    // a mirror row for a deleted member (their PMs were just detached).
    if (member.deletedAt) return;
    await this.paymentMethods.upsertFromStripe(member.id, pm);
  }

  private async resolveMemberId(
    metadataMemberId: string | null,
    customerId: string | null,
  ): Promise<string | null> {
    if (metadataMemberId) return metadataMemberId;
    if (!customerId) return null;
    return (await this.members.findByStripeCustomerId(customerId))?.id ?? null;
  }
}
