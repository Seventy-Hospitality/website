import type Stripe from 'stripe';
import type {
  BookingPaymentPort,
  PaymentIntentHandle,
  PaymentStatus,
} from '@/lib/contexts/bookings/domain';
import { CURRENCY, assertChargeableAmount, bookingChargeLedgerDraft, refundLedgerDraft } from '../domain';
import type { MemberBillingDirectory } from '../application/ports';
import type { StripeGateway } from './stripe.gateway';
import type { TransactionRepository } from './transaction.repository';

/**
 * The real BookingPaymentPort: on-session PaymentIntents (the member is
 * present; off_session would forfeit the 3DS liability shift and turn any
 * step-up into an unrecoverable decline), automatic payment methods with
 * redirects disabled, server-authoritative amounts, idempotency key per
 * reservation attempt, metadata.reservationId in both directions.
 *
 * Ledger writes here are OBSERVATIONS, best-effort by design: the webhook
 * and the nightly reconcile sweep converge on the same
 * [stripeObjectType, stripeObjectId] rows, so a failed observation costs
 * seconds of ledger lag, never money. A ledger failure must never fail the
 * money path it rides on.
 */
export class StripeBookingPaymentAdapter implements BookingPaymentPort {
  private readonly stripe: Stripe;

  constructor(
    gateway: StripeGateway,
    private readonly members: MemberBillingDirectory,
    private readonly ledger: TransactionRepository,
  ) {
    this.stripe = gateway.client;
  }

  async createPaymentIntent(input: {
    reservationId: string;
    memberId: string;
    amountCents: number;
    attempt: number;
  }): Promise<PaymentIntentHandle> {
    assertChargeableAmount(input.amountCents);

    const member = await this.members.getById(input.memberId);
    if (!member) throw new Error(`Member not found for payment: ${input.memberId}`);

    let customerId = member.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email: member.email,
        name: `${member.firstName} ${member.lastName}`,
        metadata: { memberId: member.id, source: 'seventy' },
      });
      customerId = customer.id;
      await this.members.setStripeCustomerId(member.id, customerId);
    }

    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: CURRENCY,
        customer: customerId,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { reservationId: input.reservationId, memberId: input.memberId, source: 'seventy' },
        receipt_email: member.email,
      },
      // Keyed per reservation attempt: a same-attempt retry (double-tap,
      // SDK network retry) returns the SAME intent instead of double
      // charging. A declined intent stays confirmable with another card,
      // so retries after decline reuse the intent client-side.
      { idempotencyKey: `reservation:${input.reservationId}:attempt:${input.attempt}` },
    );

    return { paymentIntentId: intent.id, clientSecret: intent.client_secret! };
  }

  async getPaymentStatus(paymentIntentId: string): Promise<PaymentStatus> {
    const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge'],
    });

    if (intent.status === 'succeeded') {
      // Observation write: the debit lands the moment the member sees
      // "confirmed" instead of webhook-seconds later.
      await this.recordChargeObservation(intent).catch((err) => {
        console.error('[billing] ledger observation failed (webhook/reconcile will converge):', err);
      });
      return 'succeeded';
    }
    if (intent.status === 'canceled') return 'canceled';
    return 'requires_payment';
  }

  async refund(input: {
    paymentIntentId: string | null;
    amountCents: number;
    reservationId: string;
    refundKey: string;
  }): Promise<{ refundId: string }> {
    if (!input.paymentIntentId) {
      throw new Error(`Cannot refund reservation ${input.reservationId}: no payment intent`);
    }

    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountCents,
        reason: 'requested_by_customer',
        metadata: { reservationId: input.reservationId, source: 'seventy' },
        expand: ['payment_intent'],
      },
      // The reserved settlement row's id: stable across crash-retries,
      // never colliding two legitimate same-amount refunds.
      { idempotencyKey: `refund:${input.refundKey}` },
    );

    await this.recordRefundObservation(refund, input.reservationId).catch((err) => {
      console.error('[billing] ledger observation failed (webhook/reconcile will converge):', err);
    });

    return { refundId: refund.id };
  }

  async cancelPaymentIntent(paymentIntentId: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(paymentIntentId);
  }

  // ── Observation writes ──

  private async recordChargeObservation(intent: Stripe.PaymentIntent): Promise<void> {
    const reservationId = intent.metadata?.reservationId;
    if (!reservationId) return;
    const memberId = await this.resolveMemberId(intent.metadata?.memberId, intent.customer);
    if (!memberId) return;

    const charge =
      intent.latest_charge && typeof intent.latest_charge !== 'string' ? intent.latest_charge : null;
    const draft = bookingChargeLedgerDraft(
      {
        paymentIntentId: intent.id,
        status: 'succeeded',
        amountReceivedCents: intent.amount_received,
        currency: intent.currency ?? CURRENCY,
        reservationId,
        memberId,
        customerId: typeof intent.customer === 'string' ? intent.customer : intent.customer?.id ?? null,
        chargeId: charge?.id ?? (typeof intent.latest_charge === 'string' ? intent.latest_charge : null),
        occurredAt: new Date((charge?.created ?? intent.created) * 1000),
        receiptUrl: charge?.receipt_url ?? null,
        invoiceLinked: false,
      },
      memberId,
    );
    if (draft) await this.ledger.upsertByStripeObject(draft);
  }

  private async recordRefundObservation(refund: Stripe.Refund, reservationId: string): Promise<void> {
    const intent =
      refund.payment_intent && typeof refund.payment_intent !== 'string' ? refund.payment_intent : null;
    const memberId = await this.resolveMemberId(intent?.metadata?.memberId, intent?.customer);
    if (!memberId) return;

    await this.ledger.upsertByStripeObject(
      refundLedgerDraft(
        {
          refundId: refund.id,
          status: (refund.status ?? 'pending') as 'pending' | 'succeeded' | 'failed' | 'canceled',
          amountCents: refund.amount,
          currency: refund.currency,
          occurredAt: new Date(refund.created * 1000),
          paymentIntentId: intent?.id ?? (typeof refund.payment_intent === 'string' ? refund.payment_intent : null),
          chargeId: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? null,
          reservationId,
          memberId,
          customerId: null,
          invoiceLinked: false,
        },
        memberId,
      ),
    );
  }

  private async resolveMemberId(
    metadataMemberId: string | null | undefined,
    customer: string | { id: string } | Stripe.DeletedCustomer | null | undefined,
  ): Promise<string | null> {
    if (metadataMemberId) return metadataMemberId;
    const customerId = typeof customer === 'string' ? customer : customer?.id ?? null;
    if (!customerId) return null;
    return (await this.members.findByStripeCustomerId(customerId))?.id ?? null;
  }
}
