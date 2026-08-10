import { createId } from '@paralleldrive/cuid2';
import type { BookingPaymentPort, PaymentIntentHandle, PaymentStatus } from '../domain';

/**
 * TODO(package-c): billing owns Stripe; this stub is the package-C seam.
 *
 * It fakes the client secret and reports every payment as succeeded so the
 * checkout flow (pending_payment hold -> confirm) runs end to end without a
 * Stripe account, and records nothing anywhere. Package C replaces it with an
 * on-session PaymentIntent adapter (idempotency key per reservation attempt,
 * `allow_redirects: 'never'`) plus payment_intent.succeeded webhook
 * confirmation; the container is the only place that knows which one is
 * wired.
 */
export class StubBookingPaymentAdapter implements BookingPaymentPort {
  async createPaymentIntent(input: {
    reservationId: string;
    memberId: string;
    amountCents: number;
    attempt: number;
  }): Promise<PaymentIntentHandle> {
    const paymentIntentId = `pi_stub_${input.reservationId}_${input.attempt}_${createId()}`;
    return {
      paymentIntentId,
      clientSecret: `${paymentIntentId}_secret_stub`,
    };
  }

  async getPaymentStatus(): Promise<PaymentStatus> {
    return 'succeeded';
  }

  async refund(input: { amountCents: number }): Promise<{ refundId: string }> {
    void input;
    return { refundId: `re_stub_${createId()}` };
  }

  async cancelPaymentIntent(): Promise<void> {
    // Nothing to cancel: no real intent exists.
  }
}
