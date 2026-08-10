// Plain data contracts between the Stripe gateway (infrastructure) and the
// billing application services. The domain never sees Stripe SDK types;
// infrastructure extracts these shapes.

export interface PaymentSettlementData {
  paymentIntentId: string;
  status: 'succeeded' | 'canceled' | 'requires_payment';
  amountReceivedCents: number;
  currency: string;
  /** metadata.reservationId, when the intent belongs to a booking. */
  reservationId: string | null;
  /** metadata.memberId, when our flows created the intent. */
  memberId: string | null;
  customerId: string | null;
  chargeId: string | null;
  /** The charge's Stripe `created` (fallback: the intent's). */
  occurredAt: Date;
  receiptUrl: string | null;
  /** True when the intent pays an invoice (subscription money). */
  invoiceLinked: boolean;
}

export interface RefundData {
  refundId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action';
  amountCents: number;
  currency: string;
  occurredAt: Date;
  paymentIntentId: string | null;
  chargeId: string | null;
  /** metadata.reservationId (ours) or the intent's metadata (fallback). */
  reservationId: string | null;
  memberId: string | null;
  customerId: string | null;
  /** True when the refunded charge paid an invoice. */
  invoiceLinked: boolean;
}

export interface InvoiceLedgerData {
  invoiceId: string;
  amountPaidCents: number;
  taxCents: number;
  currency: string;
  /** paid_at when present, else the invoice's created. */
  occurredAt: Date;
  hostedInvoiceUrl: string | null;
  chargeId: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  description: string;
}

export interface PaymentMethodData {
  paymentMethodId: string;
  customerId: string | null;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

