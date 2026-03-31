import { config } from 'dotenv';
import { resolve } from 'path';
import { StripeGateway } from './stripe.gateway';

config({ path: resolve(import.meta.dirname, '../../../../.env') });

const SK = process.env.STRIPE_SECRET_KEY!;
const APP_URL = 'http://localhost:5173';

const gateway = new StripeGateway(SK, APP_URL);

describe('StripeGateway (sandbox integration)', () => {
  let customerId: string;
  let priceId: string;
  let productId: string;

  beforeAll(async () => {
    // Create a test product + price
    const product = await gateway.client.products.create({
      name: 'Integration Test Plan',
      metadata: { test: 'true' },
    });
    productId = product.id;

    const price = await gateway.client.prices.create({
      product: productId,
      unit_amount: 1000,
      currency: 'gbp',
      recurring: { interval: 'month' },
    });
    priceId = price.id;
  });

  afterAll(async () => {
    // Clean up: deactivate test product
    if (customerId) {
      await gateway.client.customers.del(customerId);
    }
    await gateway.client.products.update(productId, { active: false });
  });

  it('creates a Stripe customer with metadata', async () => {
    customerId = await gateway.createCustomer(
      'integration-test@seventy.test',
      'Integration Test',
      'mbr_integration_1',
    );

    expect(customerId).toMatch(/^cus_/);

    const customer = await gateway.client.customers.retrieve(customerId);
    expect(customer.deleted).toBeFalsy();
    if (!customer.deleted) {
      expect(customer.email).toBe('integration-test@seventy.test');
      expect(customer.name).toBe('Integration Test');
      expect(customer.metadata.memberId).toBe('mbr_integration_1');
      expect(customer.metadata.source).toBe('seventy');
    }
  });

  it('creates a checkout session with correct config', async () => {
    const url = await gateway.createCheckoutSession(
      customerId,
      priceId,
      'mbr_integration_1',
      'plan_integration_1',
    );

    expect(url).toContain('checkout.stripe.com');
  });

  it('creates a portal session', async () => {
    const url = await gateway.createPortalSession(customerId);
    expect(url).toContain('billing.stripe.com');
  });

  it('returns null for customer with no subscriptions', async () => {
    const result = await gateway.getActiveSubscription(customerId);
    expect(result).toBeNull();
  });

  describe('with an active subscription', () => {
    let subscriptionId: string;

    beforeAll(async () => {
      // Create a subscription directly (bypassing checkout for testing)
      const sub = await gateway.client.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
      });
      subscriptionId = sub.id;
    });

    afterAll(async () => {
      if (subscriptionId) {
        await gateway.client.subscriptions.cancel(subscriptionId);
      }
    });

    it('retrieves active subscription details', async () => {
      const result = await gateway.getActiveSubscription(customerId);

      expect(result).not.toBeNull();
      expect(result!.subscriptionId).toBe(subscriptionId);
      expect(result!.priceId).toBe(priceId);
      expect(result!.currentPeriodEnd).toBeInstanceOf(Date);
      expect(result!.cancelAtPeriodEnd).toBe(false);
    });

    it('retrieves subscription by ID', async () => {
      const sub = await gateway.retrieveSubscription(subscriptionId);

      expect(sub.id).toBe(subscriptionId);
      expect(sub.customer).toBe(customerId);
    });

    it('extracts subscription data correctly', async () => {
      const sub = await gateway.retrieveSubscription(subscriptionId);
      const data = gateway.extractSubscriptionData(sub);

      expect(data.subscriptionId).toBe(subscriptionId);
      expect(data.currentPeriodEnd).toBeInstanceOf(Date);
      expect(data.priceId).toBe(priceId);
      expect(typeof data.cancelAtPeriodEnd).toBe('boolean');
    });
  });

  it('verifyWebhookSignature rejects invalid signatures', () => {
    expect(() =>
      gateway.verifyWebhookSignature('{}', 'bad_sig', 'whsec_test'),
    ).toThrow();
  });
});
