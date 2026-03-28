import type { FastifyInstance } from 'fastify';
import { stripeGateway, membershipService } from '@/lib/container';
import type Stripe from 'stripe';

export async function webhookRoutes(app: FastifyInstance) {
  // Need raw body for Stripe signature verification
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/stripe', async (req, reply) => {
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
      await processEvent(event);
    } catch (err) {
      console.error(`Webhook processing failed for ${event.type}:`, err);
    }

    return reply.send({ received: true });
  });
}

async function processEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (!subId || !session.metadata?.memberId) break;
      const subscription = await stripeGateway.retrieveSubscription(subId);
      await membershipService.handleCheckoutCompleted(stripeGateway.extractCheckoutData(session, subscription));
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      await membershipService.handleSubscriptionUpdated(stripeGateway.extractSubscriptionData(subscription));
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      await membershipService.handleSubscriptionDeleted({ subscriptionId: subscription.id });
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = stripeGateway.extractInvoiceSubscriptionId(invoice);
      if (!subscriptionId) break;
      const sub = await stripeGateway.retrieveSubscription(subscriptionId);
      await membershipService.handleInvoicePaid({
        subscriptionId,
        status: sub.status as any,
        currentPeriodEnd: new Date(sub.items.data[0].current_period_end * 1000),
      });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = stripeGateway.extractInvoiceSubscriptionId(invoice);
      if (!subscriptionId) break;
      await membershipService.handleInvoicePaymentFailed({
        subscriptionId,
        status: 'past_due',
        currentPeriodEnd: new Date(),
      });
      break;
    }
  }
}
