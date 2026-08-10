import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';

const { mockStripeGateway, mockWebhookService } = vi.hoisted(() => ({
  mockStripeGateway: {
    verifyWebhookSignature: vi.fn(),
    mapWebhookEvent: vi.fn(),
  },
  mockWebhookService: {
    process: vi.fn(),
  },
}));

vi.mock('@/lib/container', () => ({
  stripeGateway: mockStripeGateway,
  webhookService: mockWebhookService,
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

const HEADERS = {
  'content-type': 'application/json',
  'stripe-signature': 'valid_sig',
} as const;

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
    mockWebhookService.process.mockResolvedValue('handled');
    mockStripeGateway.mapWebhookEvent.mockReturnValue({
      eventId: 'evt_test',
      eventType: 'customer.subscription.updated',
      kind: 'subscription_changed',
      subscriptionId: 'sub_1',
    });
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
    expect(mockWebhookService.process).not.toHaveBeenCalled();
  });

  it('returns 400 when signature verification fails', async () => {
    mockStripeGateway.verifyWebhookSignature.mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    const res = await app.inject({ method: 'POST', url: '/stripe', payload: '{}', headers: HEADERS });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid signature' });
    expect(mockWebhookService.process).not.toHaveBeenCalled();
  });

  it('verifies, maps and processes the event, answering 200', async () => {
    const event = makeEvent('customer.subscription.updated', { id: 'sub_1' });
    mockStripeGateway.verifyWebhookSignature.mockReturnValue(event);

    const res = await app.inject({ method: 'POST', url: '/stripe', payload: '{}', headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, outcome: 'handled' });
    expect(mockStripeGateway.mapWebhookEvent).toHaveBeenCalledWith(event);
    expect(mockWebhookService.process).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'subscription_changed', subscriptionId: 'sub_1' }),
    );
  });

  it('answers 200 for deliberately ignored event types', async () => {
    mockStripeGateway.verifyWebhookSignature.mockReturnValue(makeEvent('some.unknown.event', {}));
    mockStripeGateway.mapWebhookEvent.mockReturnValue({
      eventId: 'evt_test',
      eventType: 'some.unknown.event',
      kind: 'ignored',
    });
    mockWebhookService.process.mockResolvedValue('ignored');

    const res = await app.inject({ method: 'POST', url: '/stripe', payload: '{}', headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, outcome: 'ignored' });
  });

  it('answers 200 for duplicate deliveries (dedupe)', async () => {
    mockStripeGateway.verifyWebhookSignature.mockReturnValue(makeEvent('invoice.paid', {}));
    mockWebhookService.process.mockResolvedValue('duplicate');

    const res = await app.inject({ method: 'POST', url: '/stripe', payload: '{}', headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, outcome: 'duplicate' });
  });

  it('returns 500 on transient processing failure so Stripe retries (never the old catch-all 200)', async () => {
    mockStripeGateway.verifyWebhookSignature.mockReturnValue(
      makeEvent('customer.subscription.updated', { id: 'sub_err' }),
    );
    mockWebhookService.process.mockRejectedValue(new Error('DB down'));

    const res = await app.inject({ method: 'POST', url: '/stripe', payload: '{}', headers: HEADERS });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Webhook processing failed' });
  });
});
