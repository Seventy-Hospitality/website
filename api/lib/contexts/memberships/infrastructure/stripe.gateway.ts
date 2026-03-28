import Stripe from 'stripe';
import type { MembershipStatus } from '../domain';

/** Extract current_period_end from the first subscription item (Stripe v21/dahlia moved it off Subscription) */
function periodEnd(sub: Stripe.Subscription): Date {
  return new Date(sub.items.data[0].current_period_end * 1000);
}

export class StripeGateway {
  private readonly stripe: Stripe;

  constructor(stripeSecretKey: string, private readonly appUrl: string) {
    this.stripe = new Stripe(stripeSecretKey || 'sk_test_placeholder');
  }

  get client(): Stripe {
    return this.stripe;
  }

  async createCustomer(email: string, name: string, memberId: string): Promise<string> {
    const customer = await this.stripe.customers.create({
      email,
      name,
      metadata: { memberId, source: 'seventy' },
    });
    return customer.id;
  }

  async createCheckoutSession(
    customerId: string,
    priceId: string,
    memberId: string,
    planId: string,
  ): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { memberId, planId },
      success_url: `${this.appUrl}/members/${memberId}?checkout=success`,
      cancel_url: `${this.appUrl}/members/${memberId}?checkout=canceled`,
    });
    return session.url!;
  }

  async createPortalSession(customerId: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${this.appUrl}`,
    });
    return session.url;
  }

  async getActiveSubscription(customerId: string): Promise<{
    subscriptionId: string;
    priceId: string;
    status: MembershipStatus;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  } | null> {
    const subs = await this.stripe.subscriptions.list({ customer: customerId, limit: 1 });
    const sub = subs.data[0];
    if (!sub) return null;

    return {
      subscriptionId: sub.id,
      priceId: sub.items.data[0].price.id,
      status: sub.status as MembershipStatus,
      currentPeriodEnd: periodEnd(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
  }

  extractCheckoutData(session: Stripe.Checkout.Session, subscription: Stripe.Subscription) {
    return {
      memberId: session.metadata!.memberId!,
      planId: session.metadata!.planId!,
      subscriptionId: subscription.id,
      status: subscription.status as MembershipStatus,
      currentPeriodEnd: periodEnd(subscription),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    };
  }

  extractSubscriptionData(subscription: Stripe.Subscription) {
    return {
      subscriptionId: subscription.id,
      status: subscription.status as MembershipStatus,
      currentPeriodEnd: periodEnd(subscription),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      priceId: subscription.items.data[0]?.price.id ?? null,
    };
  }

  extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
    const sub = invoice.parent?.subscription_details?.subscription;
    return typeof sub === 'string' ? sub : null;
  }

  async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(subscriptionId);
  }

  verifyWebhookSignature(body: string, signature: string, secret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(body, signature, secret);
  }
}
