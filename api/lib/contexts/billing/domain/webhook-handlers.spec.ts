import {
  bookingChargeLedgerDraft,
  invoiceLedgerDraft,
  ledgerStatusFromRefundStatus,
  refundLedgerDraft,
} from './webhook-handlers';
import type { InvoiceLedgerData, PaymentSettlementData, RefundData } from './ports';

const OCCURRED = new Date('2026-06-30T23:58:00-04:00');

function invoiceData(overrides: Partial<InvoiceLedgerData> = {}): InvoiceLedgerData {
  return {
    invoiceId: 'in_1',
    amountPaidCents: 4800,
    taxCents: 0,
    currency: 'usd',
    occurredAt: OCCURRED,
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/in_1',
    chargeId: 'ch_1',
    subscriptionId: 'sub_1',
    customerId: 'cus_1',
    description: 'Membership',
    ...overrides,
  };
}

function settlementData(overrides: Partial<PaymentSettlementData> = {}): PaymentSettlementData {
  return {
    paymentIntentId: 'pi_1',
    status: 'succeeded',
    amountReceivedCents: 2000,
    currency: 'usd',
    reservationId: 'rsv_1',
    memberId: 'mem_1',
    customerId: 'cus_1',
    chargeId: 'ch_1',
    occurredAt: OCCURRED,
    receiptUrl: 'https://receipt',
    invoiceLinked: false,
    ...overrides,
  };
}

function refundData(overrides: Partial<RefundData> = {}): RefundData {
  return {
    refundId: 're_1',
    status: 'succeeded',
    amountCents: 1000,
    currency: 'usd',
    occurredAt: OCCURRED,
    paymentIntentId: 'pi_1',
    chargeId: 'ch_1',
    reservationId: 'rsv_1',
    memberId: 'mem_1',
    customerId: 'cus_1',
    invoiceLinked: false,
    ...overrides,
  };
}

describe('invoiceLedgerDraft', () => {
  it('produces a membership_fee debit anchored on the invoice id with Stripe occurredAt', () => {
    const draft = invoiceLedgerDraft(invoiceData(), 'mem_1', 'ms_1')!;
    expect(draft).toMatchObject({
      memberId: 'mem_1',
      kind: 'membership_fee',
      direction: 'debit',
      amountCents: 4800,
      status: 'succeeded',
      stripeObjectType: 'invoice',
      stripeObjectId: 'in_1',
      membershipId: 'ms_1',
      reservationId: null,
      occurredAt: OCCURRED,
      receiptUrl: 'https://invoice.stripe.com/i/in_1',
    });
  });

  it('skips zero-amount invoices (fully covered by proration credit)', () => {
    expect(invoiceLedgerDraft(invoiceData({ amountPaidCents: 0 }), 'mem_1', null)).toBeNull();
  });
});

describe('bookingChargeLedgerDraft', () => {
  it('produces a booking_fee debit anchored on the CHARGE id', () => {
    const draft = bookingChargeLedgerDraft(settlementData(), 'mem_1')!;
    expect(draft).toMatchObject({
      kind: 'booking_fee',
      direction: 'debit',
      amountCents: 2000,
      stripeObjectType: 'charge',
      stripeObjectId: 'ch_1',
      reservationId: 'rsv_1',
      occurredAt: OCCURRED,
    });
  });

  it('yields nothing for invoice-linked intents (the invoice path owns them)', () => {
    expect(bookingChargeLedgerDraft(settlementData({ invoiceLinked: true }), 'mem_1')).toBeNull();
  });

  it('yields nothing before the money actually moved', () => {
    expect(bookingChargeLedgerDraft(settlementData({ status: 'requires_payment' }), 'mem_1')).toBeNull();
    expect(bookingChargeLedgerDraft(settlementData({ chargeId: null }), 'mem_1')).toBeNull();
    expect(bookingChargeLedgerDraft(settlementData({ amountReceivedCents: 0 }), 'mem_1')).toBeNull();
  });
});

describe('refundLedgerDraft', () => {
  it('produces a booking_refund credit anchored on the refund id', () => {
    const draft = refundLedgerDraft(refundData(), 'mem_1');
    expect(draft).toMatchObject({
      kind: 'booking_refund',
      direction: 'credit',
      amountCents: 1000,
      status: 'succeeded',
      stripeObjectType: 'refund',
      stripeObjectId: 're_1',
      reservationId: 'rsv_1',
    });
  });

  it('classifies invoice-linked refunds as membership_refund', () => {
    expect(refundLedgerDraft(refundData({ invoiceLinked: true, reservationId: null }), 'mem_1').kind).toBe(
      'membership_refund',
    );
  });

  it('maps Stripe refund statuses onto ledger statuses', () => {
    expect(ledgerStatusFromRefundStatus('succeeded')).toBe('succeeded');
    expect(ledgerStatusFromRefundStatus('failed')).toBe('failed');
    expect(ledgerStatusFromRefundStatus('canceled')).toBe('canceled');
    expect(ledgerStatusFromRefundStatus('pending')).toBe('pending');
    expect(ledgerStatusFromRefundStatus('requires_action')).toBe('pending');
  });
});
