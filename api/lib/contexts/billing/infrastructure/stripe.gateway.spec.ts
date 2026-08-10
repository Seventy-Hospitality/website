import type Stripe from 'stripe';
import { StripeGateway } from './stripe.gateway';

const gateway = new StripeGateway('sk_test_fake', 'http://localhost:5173');

function makeEvent(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: 'evt_1', type, data: { object } } as unknown as Stripe.Event;
}

describe('StripeGateway.mapWebhookEvent', () => {
  it('maps subscription lifecycle events to a re-fetch trigger', () => {
    for (const type of [
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]) {
      expect(gateway.mapWebhookEvent(makeEvent(type, { id: 'sub_1' }))).toMatchObject({
        kind: 'subscription_changed',
        subscriptionId: 'sub_1',
        eventId: 'evt_1',
      });
    }
  });

  it('maps subscription_schedule events onto their subscription (pending downgrades)', () => {
    expect(
      gateway.mapWebhookEvent(makeEvent('subscription_schedule.released', { id: 'sched_1', subscription: null, released_subscription: 'sub_1' })),
    ).toMatchObject({ kind: 'subscription_changed', subscriptionId: 'sub_1' });
    expect(
      gateway.mapWebhookEvent(makeEvent('subscription_schedule.updated', { id: 'sched_1', subscription: { id: 'sub_2' } })),
    ).toMatchObject({ kind: 'subscription_changed', subscriptionId: 'sub_2' });
  });

  it('maps checkout completion with its member/customer backstop data', () => {
    expect(
      gateway.mapWebhookEvent(
        makeEvent('checkout.session.completed', {
          subscription: 'sub_1',
          customer: { id: 'cus_1' },
          metadata: { memberId: 'mem_1' },
        }),
      ),
    ).toMatchObject({ kind: 'checkout_completed', subscriptionId: 'sub_1', memberId: 'mem_1', customerId: 'cus_1' });
  });

  it('maps invoice events with the parent subscription id', () => {
    const invoice = {
      id: 'in_1',
      parent: { subscription_details: { subscription: 'sub_1' } },
    };
    expect(gateway.mapWebhookEvent(makeEvent('invoice.paid', invoice))).toMatchObject({
      kind: 'invoice_paid',
      invoiceId: 'in_1',
      subscriptionId: 'sub_1',
    });
    expect(gateway.mapWebhookEvent(makeEvent('invoice.payment_failed', invoice))).toMatchObject({
      kind: 'invoice_failed',
      subscriptionId: 'sub_1',
    });
    expect(gateway.mapWebhookEvent(makeEvent('invoice.payment_action_required', invoice))).toMatchObject({
      kind: 'invoice_failed',
      subscriptionId: 'sub_1',
    });
  });

  it('maps payment intent, refund and dispute events', () => {
    expect(gateway.mapWebhookEvent(makeEvent('payment_intent.succeeded', { id: 'pi_1' }))).toMatchObject({
      kind: 'payment_intent_succeeded',
      paymentIntentId: 'pi_1',
    });
    expect(gateway.mapWebhookEvent(makeEvent('payment_intent.payment_failed', { id: 'pi_1' }))).toMatchObject({
      kind: 'payment_intent_failed',
    });
    expect(gateway.mapWebhookEvent(makeEvent('charge.refunded', { id: 'ch_1' }))).toMatchObject({
      kind: 'charge_refunded',
      chargeId: 'ch_1',
    });
    for (const type of ['refund.updated', 'refund.created', 'refund.failed']) {
      expect(gateway.mapWebhookEvent(makeEvent(type, { id: 're_1' }))).toMatchObject({
        kind: 'refund_updated',
        refundId: 're_1',
      });
    }
    expect(
      gateway.mapWebhookEvent(makeEvent('charge.dispute.created', { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1' })),
    ).toMatchObject({ kind: 'dispute_created', chargeId: 'ch_1', paymentIntentId: 'pi_1' });
  });

  it('maps payment_method mirror events including the card-account-updater', () => {
    expect(gateway.mapWebhookEvent(makeEvent('payment_method.attached', { id: 'pm_1' }))).toMatchObject({
      kind: 'payment_method_attached',
      paymentMethodId: 'pm_1',
    });
    expect(
      gateway.mapWebhookEvent(makeEvent('payment_method.automatically_updated', { id: 'pm_1' })),
    ).toMatchObject({ kind: 'payment_method_updated' });
    expect(gateway.mapWebhookEvent(makeEvent('payment_method.detached', { id: 'pm_1' }))).toMatchObject({
      kind: 'payment_method_detached',
    });
  });

  it('marks everything else ignored (acknowledged, never retried)', () => {
    expect(gateway.mapWebhookEvent(makeEvent('product.updated', { id: 'prod_1' }))).toMatchObject({
      kind: 'ignored',
    });
  });
});

describe('StripeGateway.verifyWebhookSignature', () => {
  it('rejects an invalid signature', () => {
    expect(() => gateway.verifyWebhookSignature('{}', 'bad_sig', 'whsec_test')).toThrow();
  });
});
