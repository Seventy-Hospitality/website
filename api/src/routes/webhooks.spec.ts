import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';

const { mockStripeGateway, mockMembershipService } = vi.hoisted(() => ({
  mockStripeGateway: {
    verifyWebhookSignature: vi.fn(),
    retrieveSubscription: vi.fn(),
    extractCheckoutData: vi.fn(),
    extractSubscriptionData: vi.fn(),
    extractInvoiceSubscriptionId: vi.fn(),
  },
  mockMembershipService: {
    handleCheckoutCompleted: vi.fn(),
    handleSubscriptionUpdated: vi.fn(),
    handleSubscriptionDeleted: vi.fn(),
    handleInvoicePaid: vi.fn(),
    handleInvoicePaymentFailed: vi.fn(),
  },
}));

vi.mock('@/lib/container', () => ({
  stripeGateway: mockStripeGateway,
  membershipService: mockMembershipService,
}));

// Import after mocking
import { webhookRoutes } from './webhooks';

function makeEvent(type: string, object: Record<string, unknown>): Stripe.Event {
  return {
    id: 'evt_test',
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

describe('webhook route: POST /stripe', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(webhookRoutes, { prefix: '/' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Missing signature' });
  });

  it('returns 400 when signature verification fails', async () => {
    mockStripeGateway.verifyWebhookSignature.mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/stripe',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'bad_sig',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid signature' });
  });

  describe('checkout.session.completed', () => {
    it('dispatches to handleCheckoutCompleted', async () => {
      const session = {
        subscription: 'sub_123',
        metadata: { memberId: 'mbr_1', planId: 'plan_1' },
      };
      const event = makeEvent('checkout.session.completed', session);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);

      const fakeSub = { id: 'sub_123', status: 'active' };
      mockStripeGateway.retrieveSubscription.mockResolvedValue(fakeSub);
      mockStripeGateway.extractCheckoutData.mockReturnValue({
        memberId: 'mbr_1',
        planId: 'plan_1',
        subscriptionId: 'sub_123',
        status: 'active',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockStripeGateway.retrieveSubscription).toHaveBeenCalledWith('sub_123');
      expect(mockStripeGateway.extractCheckoutData).toHaveBeenCalledWith(session, fakeSub);
      expect(mockMembershipService.handleCheckoutCompleted).toHaveBeenCalled();
    });

    it('skips processing when subscription ID is missing', async () => {
      const session = { subscription: null, metadata: { memberId: 'mbr_1' } };
      const event = makeEvent('checkout.session.completed', session);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.handleCheckoutCompleted).not.toHaveBeenCalled();
    });

    it('skips processing when memberId metadata is missing', async () => {
      const session = { subscription: 'sub_123', metadata: {} };
      const event = makeEvent('checkout.session.completed', session);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.handleCheckoutCompleted).not.toHaveBeenCalled();
    });

    it('handles expanded subscription object (not string)', async () => {
      const session = {
        subscription: { id: 'sub_expanded' },
        metadata: { memberId: 'mbr_1', planId: 'plan_1' },
      };
      const event = makeEvent('checkout.session.completed', session);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);

      const fakeSub = { id: 'sub_expanded', status: 'active' };
      mockStripeGateway.retrieveSubscription.mockResolvedValue(fakeSub);
      mockStripeGateway.extractCheckoutData.mockReturnValue({ subscriptionId: 'sub_expanded' });

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockStripeGateway.retrieveSubscription).toHaveBeenCalledWith('sub_expanded');
    });
  });

  describe('customer.subscription.updated', () => {
    it('dispatches to handleSubscriptionUpdated', async () => {
      const subscription = { id: 'sub_456', status: 'past_due' };
      const event = makeEvent('customer.subscription.updated', subscription);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);
      mockStripeGateway.extractSubscriptionData.mockReturnValue({
        subscriptionId: 'sub_456',
        status: 'past_due',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockStripeGateway.extractSubscriptionData).toHaveBeenCalledWith(subscription);
      expect(mockMembershipService.handleSubscriptionUpdated).toHaveBeenCalled();
    });
  });

  describe('customer.subscription.deleted', () => {
    it('dispatches to handleSubscriptionDeleted with subscriptionId', async () => {
      const subscription = { id: 'sub_789' };
      const event = makeEvent('customer.subscription.deleted', subscription);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.handleSubscriptionDeleted).toHaveBeenCalledWith({
        subscriptionId: 'sub_789',
      });
    });
  });

  describe('invoice.paid', () => {
    it('dispatches to handleInvoicePaid with subscription data', async () => {
      const invoice = { id: 'inv_1' };
      const event = makeEvent('invoice.paid', invoice);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);
      mockStripeGateway.extractInvoiceSubscriptionId.mockReturnValue('sub_from_inv');

      const fakeSub = {
        status: 'active',
        items: { data: [{ current_period_end: 1735689600 }] },
      };
      mockStripeGateway.retrieveSubscription.mockResolvedValue(fakeSub);

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockStripeGateway.retrieveSubscription).toHaveBeenCalledWith('sub_from_inv');
      expect(mockMembershipService.handleInvoicePaid).toHaveBeenCalledWith({
        subscriptionId: 'sub_from_inv',
        status: 'active',
        currentPeriodEnd: new Date(1735689600 * 1000),
      });
    });

    it('skips processing when subscription ID is not extractable', async () => {
      const invoice = { id: 'inv_2' };
      const event = makeEvent('invoice.paid', invoice);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);
      mockStripeGateway.extractInvoiceSubscriptionId.mockReturnValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.handleInvoicePaid).not.toHaveBeenCalled();
    });
  });

  describe('invoice.payment_failed', () => {
    it('dispatches to handleInvoicePaymentFailed with past_due status', async () => {
      const invoice = { id: 'inv_3' };
      const event = makeEvent('invoice.payment_failed', invoice);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);
      mockStripeGateway.extractInvoiceSubscriptionId.mockReturnValue('sub_fail');

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.handleInvoicePaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionId: 'sub_fail',
          status: 'past_due',
        }),
      );
    });

    it('skips processing when subscription ID is not extractable', async () => {
      const invoice = { id: 'inv_4' };
      const event = makeEvent('invoice.payment_failed', invoice);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);
      mockStripeGateway.extractInvoiceSubscriptionId.mockReturnValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockMembershipService.handleInvoicePaymentFailed).not.toHaveBeenCalled();
    });
  });

  describe('unknown event type', () => {
    it('returns 200 and does not call any service method', async () => {
      const event = makeEvent('some.unknown.event', { id: 'obj_1' });
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
      expect(mockMembershipService.handleCheckoutCompleted).not.toHaveBeenCalled();
      expect(mockMembershipService.handleSubscriptionUpdated).not.toHaveBeenCalled();
      expect(mockMembershipService.handleSubscriptionDeleted).not.toHaveBeenCalled();
      expect(mockMembershipService.handleInvoicePaid).not.toHaveBeenCalled();
      expect(mockMembershipService.handleInvoicePaymentFailed).not.toHaveBeenCalled();
    });
  });

  describe('processEvent error handling', () => {
    it('returns 200 even when processEvent throws', async () => {
      const subscription = { id: 'sub_err', status: 'active' };
      const event = makeEvent('customer.subscription.updated', subscription);
      mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);
      mockStripeGateway.extractSubscriptionData.mockReturnValue({});
      mockMembershipService.handleSubscriptionUpdated.mockRejectedValue(new Error('DB down'));

      const res = await app.inject({
        method: 'POST',
        url: '/stripe',
        payload: '{}',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'valid_sig',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
    });
  });
});
