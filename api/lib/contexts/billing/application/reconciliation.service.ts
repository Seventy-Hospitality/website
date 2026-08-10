import {
  bookingChargeLedgerDraft,
  invoiceLedgerDraft,
  ledgerStatusFromRefundStatus,
  refundLedgerDraft,
} from '../domain';
import type { StripeGateway } from '../infrastructure/stripe.gateway';
import type { TransactionRepository } from '../infrastructure/transaction.repository';
import type { WebhookEventRepository } from '../infrastructure/webhook-event.repository';
import type { BookingSettlementPort, MemberBillingDirectory, MembershipBillingLookup } from './ports';

const SWEEP_WINDOW_HOURS = 72;
const DEDUPE_RETENTION_DAYS = 30;

export interface ReconcileResult {
  charges: number;
  invoices: number;
  refunds: number;
  settlementsTriggered: number;
  unmatched: number;
  dedupeRowsPruned: number;
}

/**
 * Nightly account-wide reconcile: list every charge, paid invoice and
 * refund of the last 72h straight from Stripe and upsert the ledger, then
 * re-drive bookings settlement for booking charges. Closes every webhook
 * gap class at once: endpoint downtime, events Stripe stopped retrying,
 * handlers that failed after acknowledging, and the residual pay-vs-drop
 * TOCTOU (a capture landing after cancel() judged the intent uncaptured).
 */
export class ReconciliationService {
  constructor(
    private readonly gateway: StripeGateway,
    private readonly ledger: TransactionRepository,
    private readonly webhookEvents: WebhookEventRepository,
    private readonly members: MemberBillingDirectory,
    private readonly membershipLookup: MembershipBillingLookup,
    private readonly bookings: BookingSettlementPort,
  ) {}

  async reconcileBilling(now: Date = new Date()): Promise<ReconcileResult> {
    const since = new Date(now.getTime() - SWEEP_WINDOW_HOURS * 3600_000);
    const result: ReconcileResult = {
      charges: 0,
      invoices: 0,
      refunds: 0,
      settlementsTriggered: 0,
      unmatched: 0,
      dedupeRowsPruned: 0,
    };

    // Booking charges (metadata.reservationId). Invoice-linked charges are
    // owned by the invoice pass below.
    for (const charge of await this.gateway.listRecentCharges(since)) {
      if (!charge.reservationId || charge.invoiceLinked) continue;
      const memberId = await this.resolveMemberId(charge.memberId, charge.customerId);
      if (!memberId) {
        result.unmatched += 1;
        console.error(`[billing] reconcile: charge ${charge.chargeId} has no resolvable member`);
        continue;
      }
      const draft = bookingChargeLedgerDraft(charge, memberId);
      if (draft) {
        await this.ledger.upsertByStripeObject(draft);
        result.charges += 1;
      }
      // Re-drive settlement: confirms a paid-but-unsettled hold, recovers
      // an expired-but-paid booking, refunds an orphaned capture.
      await this.bookings.handleCapturedPayment(charge.reservationId, {
        source: 'reconcile',
        intent: { paymentIntentId: charge.paymentIntentId, amountCents: charge.amountReceivedCents },
      }).then(
        (outcome) => {
          if (outcome === 'confirmed' || outcome === 'orphan_refunded') result.settlementsTriggered += 1;
        },
        (err) => {
          // A reservation the ledger knows nothing about (deleted row):
          // alert; the money is visible in the ledger either way.
          console.error(`[billing] reconcile: settlement failed for ${charge.reservationId}:`, err);
        },
      );
    }

    // Membership fees.
    for (const invoice of await this.gateway.listRecentPaidInvoices(since)) {
      const membership = invoice.subscriptionId
        ? await this.membershipLookup.getByStripeSubscriptionId(invoice.subscriptionId)
        : null;
      const memberId =
        membership?.memberId ?? (await this.resolveMemberId(null, invoice.customerId));
      if (!memberId) {
        result.unmatched += 1;
        continue;
      }
      const draft = invoiceLedgerDraft(invoice, memberId, membership?.id ?? null);
      if (draft) {
        await this.ledger.upsertByStripeObject(draft);
        result.invoices += 1;
      }
    }

    // Refunds (ours AND dashboard-initiated goodwill refunds).
    for (const refund of await this.gateway.listRecentRefunds(since)) {
      const memberId = await this.resolveMemberId(refund.memberId, refund.customerId);
      if (memberId) {
        await this.ledger.upsertByStripeObject(refundLedgerDraft(refund, memberId));
        result.refunds += 1;
      } else {
        result.unmatched += 1;
      }
      if (refund.reservationId || refund.paymentIntentId) {
        const outcome = ledgerStatusFromRefundStatus(refund.status);
        if (outcome !== 'pending') {
          const known = await this.bookings.reconcileRefundOutcome(refund.refundId, outcome, 'reconcile');
          if (known === 'unknown') {
            await this.bookings.recordExternalRefund({
              stripeRefundId: refund.refundId,
              stripePaymentIntentId: refund.paymentIntentId,
              amountCents: refund.amountCents,
              status: outcome === 'canceled' ? 'failed' : outcome,
              source: 'reconcile',
            });
          }
        }
      }
    }

    result.dedupeRowsPruned = await this.webhookEvents.deleteOlderThan(
      new Date(now.getTime() - DEDUPE_RETENTION_DAYS * 24 * 3600_000),
    );

    return result;
  }

  /**
   * One-time historical import (job:backfill-billing-ledger): every charge,
   * paid invoice and refund since `since`, upserted into the ledger so
   * existing members see their history. LEDGER-ONLY by design: it never
   * drives bookings settlement (years-old charges belong to reservations
   * that settled long ago, or to legacy bookings that pre-date the
   * reservation model). Idempotent: re-running converges on the same rows.
   */
  async backfillLedger(since: Date = new Date(0)): Promise<{
    charges: number;
    invoices: number;
    refunds: number;
    unmatched: number;
  }> {
    const result = { charges: 0, invoices: 0, refunds: 0, unmatched: 0 };

    for (const charge of await this.gateway.listRecentCharges(since)) {
      if (!charge.reservationId || charge.invoiceLinked) continue;
      const memberId = await this.resolveMemberId(charge.memberId, charge.customerId);
      if (!memberId) {
        result.unmatched += 1;
        continue;
      }
      const draft = bookingChargeLedgerDraft(charge, memberId);
      if (draft) {
        await this.ledger.upsertByStripeObject(draft);
        result.charges += 1;
      }
    }

    for (const invoice of await this.gateway.listRecentPaidInvoices(since)) {
      const membership = invoice.subscriptionId
        ? await this.membershipLookup.getByStripeSubscriptionId(invoice.subscriptionId)
        : null;
      const memberId = membership?.memberId ?? (await this.resolveMemberId(null, invoice.customerId));
      if (!memberId) {
        result.unmatched += 1;
        continue;
      }
      const draft = invoiceLedgerDraft(invoice, memberId, membership?.id ?? null);
      if (draft) {
        await this.ledger.upsertByStripeObject(draft);
        result.invoices += 1;
      }
    }

    for (const refund of await this.gateway.listRecentRefunds(since)) {
      const memberId = await this.resolveMemberId(refund.memberId, refund.customerId);
      if (!memberId) {
        result.unmatched += 1;
        continue;
      }
      await this.ledger.upsertByStripeObject(refundLedgerDraft(refund, memberId));
      result.refunds += 1;
    }

    return result;
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
