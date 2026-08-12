// The member-facing money ledger: one row per Stripe money movement.
// Stripe is truth for money movement; the ledger is truth for domain
// meaning (which booking, why the refund). [stripeObjectType,
// stripeObjectId] is the idempotency anchor every writer (webhook, refund
// adapter, reconcile sweep) upserts on.

export type TransactionKind =
  | 'membership_fee'
  | 'booking_fee'
  | 'booking_refund'
  | 'membership_refund'
  | 'adjustment';

export type TransactionDirection = 'debit' | 'credit';

export type TransactionStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

export type StripeObjectType = 'invoice' | 'charge' | 'refund';

export interface BillingTransaction {
  id: string;
  memberId: string;
  kind: TransactionKind;
  direction: TransactionDirection;
  /** Always positive; direction carries the sign. */
  amountCents: number;
  taxCents: number;
  currency: string;
  status: TransactionStatus;
  /** Stripe's `created` for the underlying object, never our insert time. */
  occurredAt: Date;
  description: string;
  stripeObjectType: StripeObjectType;
  stripeObjectId: string;
  stripeChargeId: string | null;
  receiptUrl: string | null;
  reservationId: string | null;
  membershipId: string | null;
  stripeEventId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a writer upserts; ids/timestamps are storage concerns. */
export type LedgerEntryDraft = Omit<BillingTransaction, 'id' | 'createdAt' | 'updatedAt'>;
