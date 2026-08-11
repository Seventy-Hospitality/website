import Stripe from 'stripe';
import {
  normalizeSubscriptionStatus,
  type LatestInvoicePaymentState,
  type SubscriptionSnapshot,
} from '@/lib/contexts/memberships/domain';
import type { SubscriptionGateway } from '@/lib/contexts/memberships';
import { CURRENCY } from '../domain';
import type {
  InvoiceLedgerData,
  PaymentMethodData,
  PaymentSettlementData,
  RefundData,
  StripeEventRef,
} from '../domain';

/**
 * The API version the MOBILE Stripe SDK pins (PaymentSheet). Ephemeral keys
 * MUST be minted with this version, not stripe-node's pin: a key minted for
 * the wrong version makes PaymentSheet's saved-card list come back empty.
 * Override via env when the app's Stripe SDK is upgraded.
 */
export const STRIPE_MOBILE_API_VERSION =
  process.env.STRIPE_MOBILE_API_VERSION?.trim() || '2026-03-25.dahlia';

/** Extract current_period_end from the first subscription item (Stripe v21/dahlia moved it off Subscription) */
function periodEnd(sub: Stripe.Subscription): Date {
  return new Date(sub.items.data[0].current_period_end * 1000);
}

function unix(seconds: number | null | undefined, fallback?: Date): Date {
  return seconds ? new Date(seconds * 1000) : fallback ?? new Date();
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

/**
 * When this response was produced, from Stripe's own Date header: the
 * fetch-time ordering guard must not depend on our instances' clocks.
 */
function fetchedAtOf(response: { lastResponse?: { headers?: Record<string, string> } }, before: Date): Date {
  const header = response.lastResponse?.headers?.date;
  if (header) {
    const parsed = new Date(header);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return before;
}

export class StripeGateway implements SubscriptionGateway {
  private readonly stripe: Stripe;

  constructor(stripeSecretKey: string, private readonly appUrl: string) {
    // Pin the API version: an SDK bump must never silently reshape webhook/response payloads.
    this.stripe = new Stripe(stripeSecretKey || 'sk_test_placeholder', { apiVersion: '2026-03-25.dahlia' });
  }

  get client(): Stripe {
    return this.stripe;
  }

  // ── Customers ──

  async createCustomer(email: string, name: string, memberId: string): Promise<string> {
    const customer = await this.stripe.customers.create({
      email,
      name,
      metadata: { memberId, source: 'seventy' },
    });
    return customer.id;
  }

  // ── Subscription lifecycle (memberships' SubscriptionGateway port) ──

  async createIncompleteSubscription(input: {
    customerId: string;
    priceId: string;
    memberId: string;
    planId: string;
    termsVersion: string;
  }): Promise<{ snapshot: SubscriptionSnapshot; clientSecret: string | null }> {
    const before = new Date();
    const sub = await this.stripe.subscriptions.create({
      customer: input.customerId,
      items: [{ price: input.priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata: {
        memberId: input.memberId,
        planId: input.planId,
        termsVersion: input.termsVersion,
        source: 'seventy',
      },
      expand: ['latest_invoice.confirmation_secret'],
    });
    return {
      snapshot: this.toSnapshot(sub, fetchedAtOf(sub, before)),
      clientSecret: confirmationSecretOf(sub.latest_invoice),
    };
  }

  async getConfirmationSecret(subscriptionId: string): Promise<string | null> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.confirmation_secret'],
    });
    if (sub.status !== 'incomplete') return null;
    return confirmationSecretOf(sub.latest_invoice);
  }

  /**
   * The latest invoice's collection state for the confirm read-back. The
   * invoice no longer carries payment_intent directly (dahlia); its
   * payments list does, so the newest payment's intent is the observation.
   */
  async getLatestPaymentState(subscriptionId: string): Promise<LatestInvoicePaymentState | null> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payments.data.payment.payment_intent'],
    });
    const invoice = sub.latest_invoice;
    if (!invoice || typeof invoice === 'string') return null;

    const payments = invoice.payments?.data ?? [];
    const latest = [...payments].sort((a, b) => b.created - a.created)[0];
    const intentRef = latest?.payment.payment_intent;
    const intent = intentRef && typeof intentRef !== 'string' ? intentRef : null;

    return {
      invoiceStatus: invoice.status ?? null,
      paymentIntentStatus: intent?.status ?? null,
    };
  }

  async getSubscriptionState(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    const before = new Date();
    try {
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
      return this.toSnapshot(sub, fetchedAtOf(sub, before));
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') return null;
      throw err;
    }
  }

  /**
   * Immediate price change with prorations (upgrades). An interval switch
   * resets the billing anchor and bills now with credit for unused time,
   * which is exactly the settled upgrade policy. SCA on the proration
   * invoice surfaces as a confirmation secret.
   */
  async changeSubscriptionPrice(
    subscriptionId: string,
    priceId: string,
  ): Promise<{ snapshot: SubscriptionSnapshot; clientSecret: string | null }> {
    const before = new Date();
    const current = await this.stripe.subscriptions.retrieve(subscriptionId);
    const sub = await this.stripe.subscriptions.update(subscriptionId, {
      items: [{ id: current.items.data[0].id, price: priceId }],
      proration_behavior: 'create_prorations',
      payment_behavior: 'allow_incomplete',
      expand: ['latest_invoice.confirmation_secret'],
    });
    return {
      snapshot: this.toSnapshot(sub, fetchedAtOf(sub, before)),
      clientSecret: confirmationSecretOf(sub.latest_invoice),
    };
  }

  /**
   * Downgrade at period end via a TRANSIENT subscription schedule: phase 1
   * re-states the current price to the period end, phase 2 is the cheaper
   * price for one iteration, then the schedule auto-releases
   * (end_behavior: 'release'). proration_behavior 'none' on every level:
   * no credit, no immediate invoice. (A plain price update cannot do this:
   * an interval switch always resets the anchor and bills immediately,
   * whatever proration_behavior says.)
   */
  async scheduleDowngrade(
    subscriptionId: string,
    priceId: string,
    interval: 'month' | 'year',
  ): Promise<{ scheduleId: string; effectiveAt: Date }> {
    const schedule = await this.stripe.subscriptionSchedules.create({
      from_subscription: subscriptionId,
    });
    const phase = schedule.phases[0];
    const updated = await this.stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release',
      proration_behavior: 'none',
      phases: [
        {
          items: phase.items.map((item) => ({
            price: idOf(item.price as string | { id: string })!,
            quantity: item.quantity ?? 1,
          })),
          start_date: phase.start_date,
          end_date: phase.end_date,
          proration_behavior: 'none',
        },
        {
          items: [{ price: priceId, quantity: 1 }],
          // One billing cycle of the NEW price, then the schedule
          // auto-releases and the subscription renews under direct control.
          duration: { interval, interval_count: 1 },
          proration_behavior: 'none',
        },
      ],
    });
    return { scheduleId: updated.id, effectiveAt: unix(phase.end_date) };
  }

  /** Detach a schedule; the subscription stays live under direct control. */
  async releaseSchedule(scheduleId: string): Promise<void> {
    try {
      await this.stripe.subscriptionSchedules.release(scheduleId);
    } catch (err) {
      // Already released/completed: the desired end state.
      if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') return;
      if (err instanceof Stripe.errors.StripeError && err.message.includes('status')) return;
      throw err;
    }
  }

  async setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<SubscriptionSnapshot> {
    const before = new Date();
    const sub = await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: cancel,
    });
    return this.toSnapshot(sub, fetchedAtOf(sub, before));
  }

  /**
   * Idempotent: cancelling an already-terminal subscription answers its
   * live snapshot instead of Stripe's 400. Callers gate on the LOCAL
   * membership status, which flips only when the subscription.deleted
   * webhook lands, so a retry inside that lag window (account-deletion
   * resume, crash re-run) legitimately re-cancels a subscription Stripe
   * already terminated.
   */
  async cancelSubscriptionNow(subscriptionId: string): Promise<SubscriptionSnapshot> {
    const before = new Date();
    try {
      const sub = await this.stripe.subscriptions.cancel(subscriptionId);
      return this.toSnapshot(sub, fetchedAtOf(sub, before));
    } catch (err) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        const sub = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
        if (sub && (sub.status === 'canceled' || sub.status === 'incomplete_expired')) {
          return this.toSnapshot(sub, fetchedAtOf(sub, before));
        }
      }
      throw err;
    }
  }

  /**
   * Account-wide sweep. Paginated by hand (not auto-pagination) so every
   * page's snapshots can carry Stripe's OWN Date header as fetchedAt: the
   * fetch-time ordering guard must never mix our instance clock with the
   * webhook appliers' Stripe-header timestamps, or a skewed drift instance
   * could overwrite newer webhook state with a stale sweep snapshot.
   */
  async listAllSubscriptions(): Promise<SubscriptionSnapshot[]> {
    const snapshots: SubscriptionSnapshot[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const before = new Date();
      const page = await this.stripe.subscriptions.list({
        status: 'all',
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const fetchedAt = fetchedAtOf(page, before);
      for (const sub of page.data) {
        snapshots.push(this.toSnapshot(sub, fetchedAt));
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
    return snapshots;
  }

  private toSnapshot(sub: Stripe.Subscription, fetchedAt: Date): SubscriptionSnapshot {
    const { status, recognized } = normalizeSubscriptionStatus(sub.status);
    return {
      subscriptionId: sub.id,
      status,
      rawStatus: sub.status,
      statusRecognized: recognized,
      currentPeriodEnd: periodEnd(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      priceId: sub.items.data[0]?.price.id ?? null,
      customerId: idOf(sub.customer as string | { id: string }),
      memberId: sub.metadata?.memberId ?? null,
      scheduleId: idOf(sub.schedule as string | { id: string } | null),
      fetchedAt,
    };
  }

  // ── PaymentSheet plumbing ──

  async createEphemeralKey(customerId: string): Promise<string> {
    const key = await this.stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: STRIPE_MOBILE_API_VERSION },
    );
    return key.secret!;
  }

  async createSetupIntent(customerId: string): Promise<{ clientSecret: string }> {
    const intent = await this.stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });
    return { clientSecret: intent.client_secret! };
  }

  // ── Payment methods ──

  async getPaymentMethodData(paymentMethodId: string): Promise<PaymentMethodData | null> {
    try {
      const pm = await this.stripe.paymentMethods.retrieve(paymentMethodId);
      return toPaymentMethodData(pm);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') return null;
      throw err;
    }
  }

  /**
   * The default lives in TWO places: customer.invoice_settings (new
   * subscriptions, invoices) AND the live subscription's own
   * default_payment_method (renewals). Setting only the customer leaves the
   * renewal pinned to the old card.
   */
  async setDefaultPaymentMethod(
    customerId: string,
    subscriptionId: string | null,
    paymentMethodId: string,
  ): Promise<void> {
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    if (subscriptionId) {
      await this.stripe.subscriptions.update(subscriptionId, {
        default_payment_method: paymentMethodId,
      });
    }
  }

  async listCustomerPaymentMethods(customerId: string): Promise<PaymentMethodData[]> {
    const result: PaymentMethodData[] = [];
    for await (const pm of this.stripe.paymentMethods.list({ customer: customerId, limit: 100 })) {
      const data = toPaymentMethodData(pm);
      if (data) result.push(data);
    }
    return result;
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  /** Account closure: tag, never delete (customers.del is irreversible). */
  async tagCustomerDeleted(customerId: string, when: Date): Promise<void> {
    await this.stripe.customers.update(customerId, {
      metadata: { deleted_at: when.toISOString() },
    });
  }

  // ── Money-movement reads (webhook triggers + reconcile sweep) ──

  async getPaymentIntentSettlement(paymentIntentId: string): Promise<PaymentSettlementData | null> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      });
      return toSettlementData(intent);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') return null;
      throw err;
    }
  }

  async getRefundData(refundId: string): Promise<RefundData | null> {
    try {
      const refund = await this.stripe.refunds.retrieve(refundId, {
        expand: ['payment_intent'],
      });
      return toRefundData(refund);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') return null;
      throw err;
    }
  }

  async listRefundsForCharge(chargeId: string): Promise<RefundData[]> {
    const refunds: RefundData[] = [];
    for await (const refund of this.stripe.refunds.list({
      charge: chargeId,
      limit: 100,
      expand: ['data.payment_intent'],
    })) {
      refunds.push(toRefundData(refund));
    }
    return refunds;
  }

  async getInvoiceLedgerData(invoiceId: string): Promise<InvoiceLedgerData | null> {
    try {
      const invoice = await this.stripe.invoices.retrieve(invoiceId);
      return toInvoiceLedgerData(invoice);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') return null;
      throw err;
    }
  }

  /** Charges captured since the cutoff (nightly reconcile sweep). */
  async listRecentCharges(since: Date): Promise<PaymentSettlementData[]> {
    const charges: PaymentSettlementData[] = [];
    for await (const charge of this.stripe.charges.list({
      created: { gte: Math.floor(since.getTime() / 1000) },
      limit: 100,
    })) {
      if (charge.status !== 'succeeded' || !charge.captured) continue;
      charges.push({
        paymentIntentId: idOf(charge.payment_intent as string | { id: string }) ?? '',
        status: 'succeeded',
        amountReceivedCents: charge.amount_captured,
        currency: charge.currency,
        reservationId: charge.metadata?.reservationId ?? null,
        memberId: charge.metadata?.memberId ?? null,
        customerId: idOf(charge.customer as string | { id: string } | null),
        chargeId: charge.id,
        occurredAt: unix(charge.created),
        receiptUrl: charge.receipt_url ?? null,
        invoiceLinked: Boolean((charge as unknown as { invoice?: string | null }).invoice),
      });
    }
    return charges;
  }

  async listRecentRefunds(since: Date): Promise<RefundData[]> {
    const refunds: RefundData[] = [];
    for await (const refund of this.stripe.refunds.list({
      created: { gte: Math.floor(since.getTime() / 1000) },
      limit: 100,
      expand: ['data.payment_intent'],
    })) {
      refunds.push(toRefundData(refund));
    }
    return refunds;
  }

  async listRecentPaidInvoices(since: Date): Promise<InvoiceLedgerData[]> {
    const invoices: InvoiceLedgerData[] = [];
    for await (const invoice of this.stripe.invoices.list({
      status: 'paid',
      created: { gte: Math.floor(since.getTime() / 1000) },
      limit: 100,
    })) {
      const data = toInvoiceLedgerData(invoice);
      if (data) invoices.push(data);
    }
    return invoices;
  }

  // ── Webhooks ──

  verifyWebhookSignature(body: string, signature: string, secret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(body, signature, secret);
  }

  /**
   * Map a verified event to the plain ref the webhook service consumes.
   * Events are triggers; the ref carries ids, the handlers re-fetch.
   */
  mapWebhookEvent(event: Stripe.Event): StripeEventRef {
    const base = { eventId: event.id, eventType: event.type };
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          ...base,
          kind: 'checkout_completed',
          subscriptionId: idOf(session.subscription as string | { id: string } | null),
          memberId: session.metadata?.memberId ?? null,
          customerId: idOf(session.customer as string | { id: string } | null),
        };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        return { ...base, kind: 'subscription_changed', subscriptionId: sub.id };
      }
      case 'subscription_schedule.updated':
      case 'subscription_schedule.released':
      case 'subscription_schedule.completed':
      case 'subscription_schedule.canceled':
      case 'subscription_schedule.aborted': {
        const schedule = event.data.object as Stripe.SubscriptionSchedule;
        const subscriptionId =
          idOf(schedule.subscription as string | { id: string } | null) ??
          idOf(schedule.released_subscription as string | { id: string } | null);
        if (!subscriptionId) return { ...base, kind: 'ignored' };
        return { ...base, kind: 'subscription_changed', subscriptionId };
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        return {
          ...base,
          kind: 'invoice_paid',
          invoiceId: invoice.id!,
          subscriptionId: invoiceSubscriptionId(invoice),
        };
      }
      case 'invoice.payment_failed':
      case 'invoice.payment_action_required': {
        const invoice = event.data.object as Stripe.Invoice;
        return { ...base, kind: 'invoice_failed', subscriptionId: invoiceSubscriptionId(invoice) };
      }
      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return { ...base, kind: 'payment_intent_succeeded', paymentIntentId: intent.id };
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return { ...base, kind: 'payment_intent_failed', paymentIntentId: intent.id };
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        return { ...base, kind: 'charge_refunded', chargeId: charge.id };
      }
      case 'refund.updated':
      case 'refund.created':
      case 'refund.failed': {
        const refund = event.data.object as Stripe.Refund;
        return { ...base, kind: 'refund_updated', refundId: refund.id };
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        // The dispute's money linkage is immutable, so the event payload is
        // safe to read directly (no re-fetch needed for ids).
        return {
          ...base,
          kind: 'dispute_created',
          chargeId: idOf(dispute.charge as string | { id: string })!,
          paymentIntentId: idOf(dispute.payment_intent as string | { id: string } | null),
        };
      }
      case 'payment_method.attached': {
        const pm = event.data.object as Stripe.PaymentMethod;
        return { ...base, kind: 'payment_method_attached', paymentMethodId: pm.id };
      }
      case 'payment_method.automatically_updated':
      case 'payment_method.updated': {
        const pm = event.data.object as Stripe.PaymentMethod;
        return { ...base, kind: 'payment_method_updated', paymentMethodId: pm.id };
      }
      case 'payment_method.detached': {
        const pm = event.data.object as Stripe.PaymentMethod;
        return { ...base, kind: 'payment_method_detached', paymentMethodId: pm.id };
      }
      default:
        return { ...base, kind: 'ignored' };
    }
  }

  // ── Legacy admin flows ──

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
}

// ── Extraction helpers (Stripe shapes -> plain data) ──

function confirmationSecretOf(invoice: Stripe.Invoice | string | null | undefined): string | null {
  if (!invoice || typeof invoice === 'string') return null;
  const secret = (invoice as { confirmation_secret?: { client_secret?: string | null } | null })
    .confirmation_secret;
  return secret?.client_secret ?? null;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  return idOf(sub as string | { id: string } | null | undefined);
}

function toPaymentMethodData(pm: Stripe.PaymentMethod): PaymentMethodData | null {
  if (!pm.card) return null; // card-only product surface
  return {
    paymentMethodId: pm.id,
    customerId: idOf(pm.customer as string | { id: string } | null),
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}

function toSettlementData(intent: Stripe.PaymentIntent): PaymentSettlementData {
  const charge =
    intent.latest_charge && typeof intent.latest_charge !== 'string' ? intent.latest_charge : null;
  const status =
    intent.status === 'succeeded' ? 'succeeded' : intent.status === 'canceled' ? 'canceled' : 'requires_payment';
  return {
    paymentIntentId: intent.id,
    status,
    amountReceivedCents: intent.amount_received,
    currency: intent.currency ?? CURRENCY,
    reservationId: intent.metadata?.reservationId ?? null,
    memberId: intent.metadata?.memberId ?? null,
    customerId: idOf(intent.customer as string | { id: string } | null),
    chargeId: charge?.id ?? idOf(intent.latest_charge as string | null),
    occurredAt: unix(charge?.created ?? intent.created),
    receiptUrl: charge?.receipt_url ?? null,
    invoiceLinked: Boolean((intent as unknown as { invoice?: string | { id: string } | null }).invoice),
  };
}

function toRefundData(refund: Stripe.Refund): RefundData {
  const intent =
    refund.payment_intent && typeof refund.payment_intent !== 'string' ? refund.payment_intent : null;
  const status = (refund.status ?? 'pending') as RefundData['status'];
  return {
    refundId: refund.id,
    status: ['pending', 'succeeded', 'failed', 'canceled', 'requires_action'].includes(status)
      ? status
      : 'pending',
    amountCents: refund.amount,
    currency: refund.currency,
    occurredAt: unix(refund.created),
    paymentIntentId: intent?.id ?? idOf(refund.payment_intent as string | null),
    chargeId: idOf(refund.charge as string | { id: string } | null),
    reservationId: refund.metadata?.reservationId ?? intent?.metadata?.reservationId ?? null,
    // Our adapter stamps the reserved settlement-row id here at
    // refunds.create; ingestion uses it to ADOPT the reserved row instead
    // of double-recording a refund we originated.
    refundKey: refund.metadata?.refundKey ?? null,
    memberId: refund.metadata?.memberId ?? intent?.metadata?.memberId ?? null,
    customerId: idOf(intent?.customer as string | { id: string } | null | undefined),
    invoiceLinked: Boolean(
      (intent as unknown as { invoice?: string | { id: string } | null } | null)?.invoice,
    ),
  };
}

function toInvoiceLedgerData(invoice: Stripe.Invoice): InvoiceLedgerData | null {
  if (!invoice.id) return null;
  const taxCents = (invoice as unknown as { tax?: number | null }).tax ?? 0;
  return {
    invoiceId: invoice.id,
    amountPaidCents: invoice.amount_paid,
    taxCents,
    currency: invoice.currency,
    occurredAt: unix(invoice.status_transitions?.paid_at ?? invoice.created),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    chargeId: idOf(
      (invoice as unknown as { charge?: string | { id: string } | null }).charge ?? null,
    ),
    subscriptionId: invoiceSubscriptionId(invoice),
    customerId: idOf(invoice.customer as string | { id: string } | null),
    description: 'Membership',
  };
}
