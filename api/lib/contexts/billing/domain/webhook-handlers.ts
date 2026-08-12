import type { InvoiceLedgerData, PaymentSettlementData, RefundData } from './ports';
import type { LedgerEntryDraft, TransactionStatus } from './transaction';

/**
 * What a verified Stripe event means to us, extracted by the gateway
 * (infrastructure) into plain data. Events are TRIGGERS: handlers re-fetch
 * the referenced object and apply fresh state, so the ref only carries ids.
 */
export type StripeEventRef = { eventId: string; eventType: string } & (
  | { kind: 'checkout_completed'; subscriptionId: string | null; memberId: string | null; customerId: string | null }
  | { kind: 'subscription_changed'; subscriptionId: string }
  | { kind: 'invoice_paid'; invoiceId: string; subscriptionId: string | null }
  | { kind: 'invoice_failed'; subscriptionId: string | null }
  | { kind: 'payment_intent_succeeded'; paymentIntentId: string }
  | { kind: 'payment_intent_failed'; paymentIntentId: string }
  | { kind: 'charge_refunded'; chargeId: string }
  | { kind: 'refund_updated'; refundId: string }
  | { kind: 'dispute_created'; chargeId: string; paymentIntentId: string | null }
  | { kind: 'payment_method_attached'; paymentMethodId: string }
  | { kind: 'payment_method_updated'; paymentMethodId: string }
  | { kind: 'payment_method_detached'; paymentMethodId: string }
  | { kind: 'ignored' }
);

export function ledgerStatusFromRefundStatus(status: RefundData['status']): TransactionStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'pending'; // pending / requires_action: money committed to move
  }
}

/**
 * Ledger draft for a paid subscription invoice. Zero-amount invoices (fully
 * covered by proration credit) produce no row.
 */
export function invoiceLedgerDraft(
  data: InvoiceLedgerData,
  memberId: string,
  membershipId: string | null,
): LedgerEntryDraft | null {
  if (data.amountPaidCents <= 0) return null;
  return {
    memberId,
    kind: 'membership_fee',
    direction: 'debit',
    amountCents: data.amountPaidCents,
    taxCents: data.taxCents,
    currency: data.currency,
    status: 'succeeded',
    occurredAt: data.occurredAt,
    description: data.description,
    stripeObjectType: 'invoice',
    stripeObjectId: data.invoiceId,
    stripeChargeId: data.chargeId,
    receiptUrl: data.hostedInvoiceUrl,
    reservationId: null,
    membershipId,
    stripeEventId: null,
  };
}

/**
 * Ledger draft for a captured booking charge. Anchored on the CHARGE id
 * (refunds attach to charges), so webhook and reconcile sweep converge.
 * Invoice-linked intents produce no row here: the invoice path owns them.
 */
export function bookingChargeLedgerDraft(
  data: PaymentSettlementData,
  memberId: string,
): LedgerEntryDraft | null {
  if (data.invoiceLinked || !data.chargeId) return null;
  if (data.status !== 'succeeded' || data.amountReceivedCents <= 0) return null;
  return {
    memberId,
    kind: 'booking_fee',
    direction: 'debit',
    amountCents: data.amountReceivedCents,
    taxCents: 0,
    currency: data.currency,
    status: 'succeeded',
    occurredAt: data.occurredAt,
    description: 'Facility booking',
    stripeObjectType: 'charge',
    stripeObjectId: data.chargeId,
    stripeChargeId: data.chargeId,
    receiptUrl: data.receiptUrl,
    reservationId: data.reservationId,
    membershipId: null,
    stripeEventId: null,
  };
}

/** Ledger draft for a refund (booking or membership money coming back). */
export function refundLedgerDraft(data: RefundData, memberId: string): LedgerEntryDraft {
  return {
    memberId,
    kind: data.invoiceLinked ? 'membership_refund' : 'booking_refund',
    direction: 'credit',
    amountCents: data.amountCents,
    taxCents: 0,
    currency: data.currency,
    status: ledgerStatusFromRefundStatus(data.status),
    occurredAt: data.occurredAt,
    description: data.invoiceLinked ? 'Membership refund' : 'Booking refund',
    stripeObjectType: 'refund',
    stripeObjectId: data.refundId,
    stripeChargeId: data.chargeId,
    receiptUrl: null,
    reservationId: data.reservationId,
    membershipId: null,
    stripeEventId: null,
  };
}
