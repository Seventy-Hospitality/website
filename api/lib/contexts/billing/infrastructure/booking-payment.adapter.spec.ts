import { StripeBookingPaymentAdapter } from './booking-payment.adapter';
import { MinimumChargeNotMetError } from '../domain';
import type { StripeGateway } from './stripe.gateway';

// The Stripe SDK is mocked at the gateway/client boundary, the same
// boundary the memberships specs used: the adapter's behavior (params,
// idempotency keys, observations) is what is under test.
function fakeStripe() {
  return {
    customers: {
      create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
    },
    paymentIntents: {
      create: vi.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'pi_1_secret' }),
      retrieve: vi.fn(),
      cancel: vi.fn().mockResolvedValue({}),
    },
    refunds: {
      create: vi.fn().mockResolvedValue({
        id: 're_1',
        status: 'succeeded',
        amount: 1000,
        currency: 'usd',
        created: 1_790_000_000,
        charge: 'ch_1',
        payment_intent: {
          id: 'pi_1',
          metadata: { reservationId: 'rsv_1', memberId: 'mem_1' },
          customer: 'cus_1',
        },
      }),
    },
  };
}

function build(memberOverrides: Record<string, unknown> = {}) {
  const stripe = fakeStripe();
  const gateway = { client: stripe } as unknown as StripeGateway;
  const members = {
    getById: vi.fn().mockResolvedValue({
      id: 'mem_1',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Chen',
      stripeCustomerId: 'cus_1',
      ...memberOverrides,
    }),
    findByStripeCustomerId: vi.fn().mockResolvedValue({ id: 'mem_1' }),
    setStripeCustomerId: vi.fn(),
  };
  const ledger = { upsertByStripeObject: vi.fn() };
  const adapter = new StripeBookingPaymentAdapter(gateway, members, ledger as never);
  return { adapter, stripe, members, ledger };
}

describe('StripeBookingPaymentAdapter.createPaymentIntent', () => {
  it('creates an on-session intent: server-authoritative amount, redirects disabled, reservation metadata, per-attempt idempotency key', async () => {
    const { adapter, stripe } = build();
    const handle = await adapter.createPaymentIntent({
      reservationId: 'rsv_1',
      memberId: 'mem_1',
      amountCents: 2000,
      attempt: 1,
    });

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2000,
        currency: 'usd',
        customer: 'cus_1',
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: expect.objectContaining({ reservationId: 'rsv_1', memberId: 'mem_1' }),
      }),
      { idempotencyKey: 'reservation:rsv_1:attempt:1' },
    );
    expect(handle).toEqual({ paymentIntentId: 'pi_1', clientSecret: 'pi_1_secret' });
  });

  it('creates and persists a Stripe customer for a member without one', async () => {
    const { adapter, stripe, members } = build({ stripeCustomerId: null });
    await adapter.createPaymentIntent({ reservationId: 'rsv_1', memberId: 'mem_1', amountCents: 2000, attempt: 1 });

    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com', metadata: expect.objectContaining({ memberId: 'mem_1' }) }),
    );
    expect(members.setStripeCustomerId).toHaveBeenCalledWith('mem_1', 'cus_new');
  });

  it('blocks sub-minimum charges before Stripe is ever called (settled: block, not absorb)', async () => {
    const { adapter, stripe } = build();
    await expect(
      adapter.createPaymentIntent({ reservationId: 'rsv_1', memberId: 'mem_1', amountCents: 30, attempt: 2 }),
    ).rejects.toThrow(MinimumChargeNotMetError);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe('StripeBookingPaymentAdapter.getPaymentStatus', () => {
  it('maps succeeded/canceled and everything else to requires_payment (declined intent stays reusable)', async () => {
    const { adapter, stripe } = build();
    for (const [stripeStatus, expected] of [
      ['succeeded', 'succeeded'],
      ['canceled', 'canceled'],
      ['requires_payment_method', 'requires_payment'],
      ['requires_action', 'requires_payment'],
      ['processing', 'requires_payment'],
    ] as const) {
      stripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_1',
        status: stripeStatus,
        amount_received: 2000,
        currency: 'usd',
        created: 1_790_000_000,
        metadata: {},
        latest_charge: null,
      });
      expect(await adapter.getPaymentStatus('pi_1')).toBe(expected);
    }
  });

  it('records the booking_fee ledger observation the moment success is observed', async () => {
    const { adapter, stripe, ledger } = build();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      amount_received: 2000,
      currency: 'usd',
      created: 1_790_000_000,
      customer: 'cus_1',
      metadata: { reservationId: 'rsv_1', memberId: 'mem_1' },
      latest_charge: { id: 'ch_1', created: 1_790_000_100, receipt_url: 'https://r' },
    });

    await adapter.getPaymentStatus('pi_1');
    expect(ledger.upsertByStripeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'booking_fee',
        stripeObjectType: 'charge',
        stripeObjectId: 'ch_1',
        amountCents: 2000,
        reservationId: 'rsv_1',
        occurredAt: new Date(1_790_000_100 * 1000),
      }),
    );
  });

  it('a ledger observation failure NEVER fails the money path (webhook/reconcile converge)', async () => {
    const { adapter, stripe, ledger } = build();
    ledger.upsertByStripeObject.mockRejectedValue(new Error('DB blip'));
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      amount_received: 2000,
      currency: 'usd',
      created: 1_790_000_000,
      metadata: { reservationId: 'rsv_1', memberId: 'mem_1' },
      latest_charge: { id: 'ch_1', created: 1_790_000_100 },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await adapter.getPaymentStatus('pi_1')).toBe('succeeded');
    errorSpy.mockRestore();
  });
});

describe('StripeBookingPaymentAdapter.refund', () => {
  it('refunds via refunds.create keyed by the reserved row id and mirrors the credit into the ledger', async () => {
    const { adapter, stripe, ledger } = build();
    const result = await adapter.refund({
      paymentIntentId: 'pi_1',
      amountCents: 1000,
      reservationId: 'rsv_1',
      refundKey: 'pay_refund_row',
    });

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_1',
        amount: 1000,
        reason: 'requested_by_customer',
        metadata: expect.objectContaining({ reservationId: 'rsv_1' }),
      }),
      { idempotencyKey: 'refund:pay_refund_row' },
    );
    expect(result).toEqual({ refundId: 're_1' });
    expect(ledger.upsertByStripeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'booking_refund',
        direction: 'credit',
        stripeObjectType: 'refund',
        stripeObjectId: 're_1',
        reservationId: 'rsv_1',
      }),
    );
  });

  it('refuses to refund without a payment intent', async () => {
    const { adapter } = build();
    await expect(
      adapter.refund({ paymentIntentId: null, amountCents: 100, reservationId: 'rsv_1', refundKey: 'k' }),
    ).rejects.toThrow('no payment intent');
  });
});
