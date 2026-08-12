import { config } from 'dotenv';
import { resolve } from 'path';
import { StripeGateway } from './stripe.gateway';

config({ path: resolve(import.meta.dirname, '../../../../.env') });

const SK = process.env.STRIPE_SECRET_KEY!;
const APP_URL = 'http://localhost:5173';

const gateway = new StripeGateway(SK, APP_URL);

describe.skipIf(!SK)('StripeGateway (sandbox integration)', () => {
  let customerId: string;
  let priceId: string;
  let productId: string;

  beforeAll(async () => {
    const product = await gateway.client.products.create({
      name: 'Integration Test Plan',
      metadata: { test: 'true' },
    });
    productId = product.id;

    const price = await gateway.client.prices.create({
      product: productId,
      unit_amount: 1000,
      currency: 'usd',
      recurring: { interval: 'month' },
    });
    priceId = price.id;
  });

  afterAll(async () => {
    if (customerId) {
      await gateway.client.customers.del(customerId); // test data only
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
      expect(customer.metadata.memberId).toBe('mbr_integration_1');
      expect(customer.metadata.source).toBe('seventy');
    }
  });

  it('mints an ephemeral key at the mobile API version', async () => {
    const secret = await gateway.createEphemeralKey(customerId);
    expect(secret).toMatch(/^ek_/);
  });

  it('creates a setup intent with redirects disabled', async () => {
    const { clientSecret } = await gateway.createSetupIntent(customerId);
    expect(clientSecret).toMatch(/^seti_/);
  });

  describe('subscription-first purchase', () => {
    let subscriptionId: string;

    it('creates a default_incomplete subscription with a confirmation secret', async () => {
      const { snapshot, clientSecret } = await gateway.createIncompleteSubscription({
        customerId,
        priceId,
        memberId: 'mbr_integration_1',
        planId: 'plan_integration_1',
        termsVersion: '2026-01',
      });

      subscriptionId = snapshot.subscriptionId;
      expect(subscriptionId).toMatch(/^sub_/);
      expect(snapshot.status).toBe('incomplete');
      expect(snapshot.memberId).toBe('mbr_integration_1');
      expect(clientSecret).toBeTruthy();
    });

    it('reads back fresh subscription state with a fetch timestamp', async () => {
      const snapshot = await gateway.getSubscriptionState(subscriptionId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.priceId).toBe(priceId);
      expect(snapshot!.currentPeriodEnd).toBeInstanceOf(Date);
      expect(snapshot!.fetchedAt).toBeInstanceOf(Date);
    });

    it('lists the subscription in the account-wide sweep', async () => {
      const snapshots = await gateway.listAllSubscriptions();
      expect(snapshots.some((snap) => snap.subscriptionId === subscriptionId)).toBe(true);
    });

    it('cancels immediately and reports the canceled snapshot', async () => {
      const snapshot = await gateway.cancelSubscriptionNow(subscriptionId);
      expect(snapshot.status).toBe('canceled');
      expect(await gateway.getConfirmationSecret(subscriptionId)).toBeNull();
    });
  });

  it('creates checkout and portal sessions (legacy admin flows)', async () => {
    const url = await gateway.createCheckoutSession(customerId, priceId, 'mbr_integration_1', 'plan_integration_1');
    expect(url).toContain('checkout.stripe.com');

    const portalUrl = await gateway.createPortalSession(customerId);
    expect(portalUrl).toContain('billing.stripe.com');
  });

  it('verifyWebhookSignature rejects invalid signatures', () => {
    expect(() => gateway.verifyWebhookSignature('{}', 'bad_sig', 'whsec_test')).toThrow();
  });
});
