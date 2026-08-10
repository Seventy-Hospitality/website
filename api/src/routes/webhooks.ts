import type { FastifyInstance } from 'fastify';
import { stripeGateway, webhookService } from '@/lib/container';
import type Stripe from 'stripe';

/**
 * Thin transport: verify the signature, map the event, hand it to the
 * billing webhook service. A processing failure answers 500 so Stripe
 * RETRIES (the dedupe table records an event only after success, and every
 * handler is idempotent, so retries are safe); 200 is reserved for
 * handled, deliberately-ignored and duplicate events.
 */
export async function webhookRoutes(app: FastifyInstance) {
  // Need raw body for Stripe signature verification
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/stripe', { config: { policy: 'webhook' } }, async (req, reply) => {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      return reply.status(400).send({ error: 'Missing signature' });
    }

    let event: Stripe.Event;
    try {
      event = stripeGateway.verifyWebhookSignature(
        req.body as string,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch {
      return reply.status(400).send({ error: 'Invalid signature' });
    }

    try {
      const outcome = await webhookService.process(stripeGateway.mapWebhookEvent(event));
      return reply.send({ received: true, outcome });
    } catch (err) {
      req.log.error({ err, eventId: event.id, eventType: event.type }, 'webhook processing failed');
      return reply.status(500).send({ error: 'Webhook processing failed' });
    }
  });
}
