import type Stripe from 'stripe';
import { StripeGateway } from './stripe.gateway';

const gateway = new StripeGateway('sk_test_fake', 'http://localhost:5173');

function makeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_abc',
    status: 'active',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          current_period_end: 1735689600, // 2025-01-01T00:00:00Z
          price: { id: 'price_xyz' },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe('StripeGateway.extractCheckoutData', () => {
  it('extracts memberId, planId, subscription fields from session + subscription', () => {
    const session = {
      metadata: { memberId: 'mbr_1', planId: 'plan_1' },
    } as unknown as Stripe.Checkout.Session;

    const subscription = makeSubscription({
      id: 'sub_123',
      status: 'active',
      cancel_at_period_end: false,
    });

    const result = gateway.extractCheckoutData(session, subscription);

    expect(result).toEqual({
      memberId: 'mbr_1',
      planId: 'plan_1',
      subscriptionId: 'sub_123',
      status: 'active',
      currentPeriodEnd: new Date(1735689600 * 1000),
      cancelAtPeriodEnd: false,
    });
  });

  it('reflects cancel_at_period_end = true', () => {
    const session = {
      metadata: { memberId: 'mbr_2', planId: 'plan_2' },
    } as unknown as Stripe.Checkout.Session;

    const subscription = makeSubscription({
      cancel_at_period_end: true,
      status: 'trialing',
    });

    const result = gateway.extractCheckoutData(session, subscription);

    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(result.status).toBe('trialing');
  });
});

describe('StripeGateway.extractInvoiceSubscriptionId', () => {
  it('returns subscription ID from parent.subscription_details', () => {
    const invoice = {
      parent: {
        subscription_details: {
          subscription: 'sub_from_invoice',
        },
      },
    } as unknown as Stripe.Invoice;

    expect(gateway.extractInvoiceSubscriptionId(invoice)).toBe('sub_from_invoice');
  });

  it('returns null when parent is missing', () => {
    const invoice = {} as unknown as Stripe.Invoice;
    expect(gateway.extractInvoiceSubscriptionId(invoice)).toBeNull();
  });

  it('returns null when subscription_details is missing', () => {
    const invoice = {
      parent: {},
    } as unknown as Stripe.Invoice;
    expect(gateway.extractInvoiceSubscriptionId(invoice)).toBeNull();
  });

  it('returns null when subscription is not a string (expanded object)', () => {
    const invoice = {
      parent: {
        subscription_details: {
          subscription: { id: 'sub_expanded' },
        },
      },
    } as unknown as Stripe.Invoice;
    expect(gateway.extractInvoiceSubscriptionId(invoice)).toBeNull();
  });

  it('returns null when subscription is null', () => {
    const invoice = {
      parent: {
        subscription_details: {
          subscription: null,
        },
      },
    } as unknown as Stripe.Invoice;
    expect(gateway.extractInvoiceSubscriptionId(invoice)).toBeNull();
  });
});
