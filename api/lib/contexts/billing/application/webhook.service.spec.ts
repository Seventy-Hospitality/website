import { WebhookService } from './webhook.service';
import type { StripeEventRef, PaymentSettlementData, RefundData, InvoiceLedgerData } from '../domain';

const OCCURRED = new Date('2026-06-30T23:58:00-04:00');

function settlement(overrides: Partial<PaymentSettlementData> = {}): PaymentSettlementData {
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
    receiptUrl: null,
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
    refundKey: null,
    memberId: 'mem_1',
    customerId: 'cus_1',
    invoiceLinked: false,
    ...overrides,
  };
}

function invoiceData(overrides: Partial<InvoiceLedgerData> = {}): InvoiceLedgerData {
  return {
    invoiceId: 'in_1',
    amountPaidCents: 4800,
    taxCents: 0,
    currency: 'usd',
    occurredAt: OCCURRED,
    hostedInvoiceUrl: null,
    chargeId: 'ch_9',
    subscriptionId: 'sub_1',
    customerId: 'cus_1',
    description: 'Membership',
    ...overrides,
  };
}

function ref(partial: Partial<StripeEventRef> & { kind: StripeEventRef['kind'] }): StripeEventRef {
  return { eventId: 'evt_1', eventType: 'test.event', ...partial } as StripeEventRef;
}

function build() {
  const gateway = {
    listRefundsForCharge: vi.fn().mockResolvedValue([refundData()]),
    getRefundData: vi.fn().mockResolvedValue(refundData()),
    getInvoiceLedgerData: vi.fn().mockResolvedValue(invoiceData()),
    getPaymentIntentSettlement: vi.fn().mockResolvedValue(settlement()),
    getPaymentMethodData: vi.fn().mockResolvedValue({
      paymentMethodId: 'pm_1',
      customerId: 'cus_1',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    }),
  };
  const webhookEvents = {
    wasProcessed: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn(),
    deleteOlderThan: vi.fn().mockResolvedValue(0),
  };
  const ledger = { upsertByStripeObject: vi.fn() };
  const paymentMethods = {
    upsertFromStripe: vi.fn(),
    deleteByStripeId: vi.fn(),
  };
  const memberships = {
    applySubscriptionState: vi.fn().mockResolvedValue({ applied: true, outcome: 'updated' }),
  };
  const membershipLookup = {
    getByStripeSubscriptionId: vi
      .fn()
      .mockResolvedValue({ id: 'ms_1', memberId: 'mem_1', stripeSubscriptionId: 'sub_1', status: 'active' }),
    getCurrentForMember: vi.fn().mockResolvedValue(null),
  };
  const bookings = {
    handleCapturedPayment: vi.fn().mockResolvedValue('confirmed'),
    reconcileRefundOutcome: vi.fn().mockResolvedValue('reconciled'),
    recordExternalRefund: vi.fn().mockResolvedValue('recorded'),
    redriveStalePendingRefunds: vi.fn().mockResolvedValue({ reissued: 0, failed: 0 }),
    freezeChargeForDispute: vi.fn().mockResolvedValue(['rsv_1']),
    hasBlockingFinancialState: vi.fn().mockResolvedValue(false),
    hasOpenDisputes: vi.fn().mockResolvedValue(false),
  };
  const members = {
    getById: vi.fn(),
    findByStripeCustomerId: vi.fn().mockResolvedValue({ id: 'mem_1' }),
    setStripeCustomerId: vi.fn().mockResolvedValue(undefined),
  };

  const audit = { append: vi.fn().mockResolvedValue({ id: 'evt_1', seq: 1 }) };
  const uow = { execute: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) };

  const service = new WebhookService(
    gateway as never,
    webhookEvents as never,
    ledger as never,
    paymentMethods as never,
    memberships,
    membershipLookup,
    bookings,
    members,
    audit,
    uow as never,
  );
  return { service, gateway, webhookEvents, ledger, paymentMethods, memberships, membershipLookup, bookings, members, audit, uow };
}

describe('WebhookService dedupe and outcomes', () => {
  it('acknowledges ignored event kinds without touching the dedupe table', async () => {
    const { service, webhookEvents } = build();
    expect(await service.process(ref({ kind: 'ignored' }))).toBe('ignored');
    expect(webhookEvents.wasProcessed).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });

  it('skips an already-processed event id (redelivery)', async () => {
    const { service, webhookEvents, memberships } = build();
    webhookEvents.wasProcessed.mockResolvedValue(true);
    expect(await service.process(ref({ kind: 'subscription_changed', subscriptionId: 'sub_1' }))).toBe('duplicate');
    expect(memberships.applySubscriptionState).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });

  it('records the event id only AFTER successful processing', async () => {
    const { service, webhookEvents } = build();
    await service.process(ref({ kind: 'subscription_changed', subscriptionId: 'sub_1' }));
    expect(webhookEvents.markProcessed).toHaveBeenCalledWith('evt_1', 'test.event');
  });

  it('propagates a transient failure WITHOUT recording the dedupe row (Stripe must retry)', async () => {
    const { service, webhookEvents, memberships } = build();
    memberships.applySubscriptionState.mockRejectedValue(new Error('DB down'));
    await expect(
      service.process(ref({ kind: 'subscription_changed', subscriptionId: 'sub_1' })),
    ).rejects.toThrow('DB down');
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });
});

describe('subscription-shaped events', () => {
  it('treats subscription events as triggers into the memberships re-fetch-and-apply', async () => {
    const { service, memberships } = build();
    await service.process(ref({ kind: 'subscription_changed', subscriptionId: 'sub_1' }));
    expect(memberships.applySubscriptionState).toHaveBeenCalledWith('sub_1');
  });

  it('checkout.session.completed backstops the customer id and applies with a member fallback', async () => {
    const { service, memberships, members } = build();
    await service.process(
      ref({ kind: 'checkout_completed', subscriptionId: 'sub_1', memberId: 'mem_1', customerId: 'cus_1' } as never),
    );
    expect(members.setStripeCustomerId).toHaveBeenCalledWith('mem_1', 'cus_1');
    expect(memberships.applySubscriptionState).toHaveBeenCalledWith('sub_1', { fallbackMemberId: 'mem_1' });
  });

  it('invoice.payment_action_required (SCA on renewal) re-applies fresh subscription state', async () => {
    const { service, memberships } = build();
    await service.process(ref({ kind: 'invoice_failed', subscriptionId: 'sub_1' } as never));
    expect(memberships.applySubscriptionState).toHaveBeenCalledWith('sub_1');
  });

  it('a failed renewal appends billing.payment_failed for the member (dunning rides the outbox)', async () => {
    const { service, audit } = build();
    await service.process(ref({ kind: 'invoice_failed', subscriptionId: 'sub_1' } as never));
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), {
      streamType: 'billing',
      streamId: 'mem_1',
      eventType: 'billing.payment_failed',
      data: { memberId: 'mem_1', stripeSubscriptionId: 'sub_1' },
      source: 'webhook',
    });
  });

  it('no billing.payment_failed row when the subscription resolves to no membership', async () => {
    const { service, audit, membershipLookup } = build();
    membershipLookup.getByStripeSubscriptionId.mockResolvedValue(null);
    await service.process(ref({ kind: 'invoice_failed', subscriptionId: 'sub_unknown' } as never));
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe('invoice.paid', () => {
  it('re-fetches the invoice and upserts a membership_fee row keyed by invoice id', async () => {
    const { service, ledger, memberships } = build();
    await service.process(ref({ kind: 'invoice_paid', invoiceId: 'in_1', subscriptionId: 'sub_1' } as never));

    expect(memberships.applySubscriptionState).toHaveBeenCalledWith('sub_1');
    expect(ledger.upsertByStripeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'membership_fee',
        stripeObjectType: 'invoice',
        stripeObjectId: 'in_1',
        memberId: 'mem_1',
        membershipId: 'ms_1',
        occurredAt: OCCURRED,
      }),
    );
  });

  it('alerts instead of throwing when no member resolves (permanently unhandleable)', async () => {
    const { service, ledger, membershipLookup, members } = build();
    membershipLookup.getByStripeSubscriptionId.mockResolvedValue(null);
    members.findByStripeCustomerId.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await service.process(ref({ kind: 'invoice_paid', invoiceId: 'in_1', subscriptionId: 'sub_1' } as never));
    expect(ledger.upsertByStripeObject).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('payment_intent.succeeded', () => {
  it('writes the booking_fee ledger row and settles through bookings with the intent attached', async () => {
    const { service, ledger, bookings } = build();
    await service.process(ref({ kind: 'payment_intent_succeeded', paymentIntentId: 'pi_1' } as never));

    expect(ledger.upsertByStripeObject).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'booking_fee', stripeObjectType: 'charge', stripeObjectId: 'ch_1' }),
    );
    expect(bookings.handleCapturedPayment).toHaveBeenCalledWith('rsv_1', {
      source: 'webhook',
      intent: { paymentIntentId: 'pi_1', amountCents: 2000 },
    });
  });

  it('lets a settlement failure propagate as a 500 (hold row not yet visible: retry, never drop)', async () => {
    const { service, bookings, webhookEvents } = build();
    bookings.handleCapturedPayment.mockRejectedValue(new Error('Reservation not found: rsv_1'));
    await expect(
      service.process(ref({ kind: 'payment_intent_succeeded', paymentIntentId: 'pi_1' } as never)),
    ).rejects.toThrow('Reservation not found');
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });

  it('ignores subscription-money intents (no reservation linkage)', async () => {
    const { service, gateway, ledger, bookings } = build();
    gateway.getPaymentIntentSettlement.mockResolvedValue(settlement({ reservationId: null }));
    await service.process(ref({ kind: 'payment_intent_succeeded', paymentIntentId: 'pi_9' } as never));
    expect(ledger.upsertByStripeObject).not.toHaveBeenCalled();
    expect(bookings.handleCapturedPayment).not.toHaveBeenCalled();
  });
});

describe('refund events', () => {
  it('charge.refunded upserts every refund of the charge and finalizes known ones in bookings', async () => {
    const { service, ledger, bookings } = build();
    await service.process(ref({ kind: 'charge_refunded', chargeId: 'ch_1' } as never));

    expect(ledger.upsertByStripeObject).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'booking_refund', stripeObjectId: 're_1', stripeEventId: 'evt_1' }),
    );
    expect(bookings.reconcileRefundOutcome).toHaveBeenCalledWith('re_1', 'succeeded', 'webhook');
  });

  it('records a dashboard goodwill refund into BOTH the ledger and the bookings settlement record', async () => {
    const { service, bookings } = build();
    bookings.reconcileRefundOutcome.mockResolvedValue('unknown');
    await service.process(ref({ kind: 'refund_updated', refundId: 're_1' } as never));

    expect(bookings.recordExternalRefund).toHaveBeenCalledWith({
      stripeRefundId: 're_1',
      stripePaymentIntentId: 'pi_1',
      amountCents: 1000,
      status: 'succeeded',
      refundKey: null,
      source: 'webhook',
    });
  });

  it('an async refund FAILURE flows into bookings finalization (row flip + restore)', async () => {
    const { service, gateway, bookings, ledger } = build();
    gateway.getRefundData.mockResolvedValue(refundData({ status: 'failed' }));
    await service.process(ref({ kind: 'refund_updated', refundId: 're_1' } as never));

    expect(ledger.upsertByStripeObject).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(bookings.reconcileRefundOutcome).toHaveBeenCalledWith('re_1', 'failed', 'webhook');
  });
});

describe('dispute + payment methods', () => {
  it('charge.dispute.created freezes the linked reservation financially', async () => {
    const { service, bookings } = build();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await service.process(ref({ kind: 'dispute_created', chargeId: 'ch_1', paymentIntentId: 'pi_1' } as never));
    expect(bookings.freezeChargeForDispute).toHaveBeenCalledWith('pi_1', 'webhook');
    errorSpy.mockRestore();
  });

  it('charge.dispute.created appends billing.dispute_opened (the staff alert rides the outbox)', async () => {
    const { service, audit } = build();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await service.process(ref({ kind: 'dispute_created', chargeId: 'ch_1', paymentIntentId: 'pi_1' } as never));
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), {
      streamType: 'billing',
      streamId: 'ch_1',
      eventType: 'billing.dispute_opened',
      data: { chargeId: 'ch_1', paymentIntentId: 'pi_1', reservationIds: ['rsv_1'] },
      source: 'webhook',
    });
    errorSpy.mockRestore();
  });

  it('an unlinked dispute (no payment intent) still alerts staff via the outbox row', async () => {
    const { service, audit, bookings } = build();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await service.process(ref({ kind: 'dispute_created', chargeId: 'ch_2', paymentIntentId: null } as never));
    expect(bookings.freezeChargeForDispute).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'billing.dispute_opened', streamId: 'ch_2' }),
    );
    errorSpy.mockRestore();
  });

  it('payment_method.attached mirrors the card for the owning member', async () => {
    const { service, paymentMethods } = build();
    await service.process(ref({ kind: 'payment_method_attached', paymentMethodId: 'pm_1' } as never));
    expect(paymentMethods.upsertFromStripe).toHaveBeenCalledWith(
      'mem_1',
      expect.objectContaining({ paymentMethodId: 'pm_1', brand: 'visa', last4: '4242' }),
    );
  });

  it('payment_method.automatically_updated refreshes the mirror (card-account-updater)', async () => {
    const { service, gateway, paymentMethods } = build();
    gateway.getPaymentMethodData.mockResolvedValue({
      paymentMethodId: 'pm_1',
      customerId: 'cus_1',
      brand: 'visa',
      last4: '0341',
      expMonth: 1,
      expYear: 2032,
    });
    await service.process(ref({ kind: 'payment_method_updated', paymentMethodId: 'pm_1' } as never));
    expect(paymentMethods.upsertFromStripe).toHaveBeenCalledWith(
      'mem_1',
      expect.objectContaining({ last4: '0341', expYear: 2032 }),
    );
  });

  it('payment_method.detached deletes the mirror row', async () => {
    const { service, paymentMethods } = build();
    await service.process(ref({ kind: 'payment_method_detached', paymentMethodId: 'pm_1' } as never));
    expect(paymentMethods.deleteByStripeId).toHaveBeenCalledWith('pm_1');
  });
});
