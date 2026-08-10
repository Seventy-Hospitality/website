import type { StripeGateway } from '../infrastructure/stripe.gateway';
import type { PaymentMethodRepository } from '../infrastructure/payment-method.repository';
import type { MemberBillingDirectory, MembershipBillingLookup } from './ports';

export class PaymentMethodNotFoundError extends Error {
  constructor() {
    super('Payment method not found');
    this.name = 'PaymentMethodNotFoundError';
  }
}

export interface SetupIntentResult {
  clientSecret: string;
  customerId: string;
  ephemeralKeySecret: string;
}

/** Payment-method management ("Edit payment method" = PaymentSheet setup mode). */
export class PaymentService {
  constructor(
    private readonly gateway: StripeGateway,
    private readonly paymentMethods: PaymentMethodRepository,
    private readonly members: MemberBillingDirectory,
    private readonly membershipLookup: MembershipBillingLookup,
  ) {}

  async createSetupIntent(memberId: string): Promise<SetupIntentResult> {
    const member = await this.members.getById(memberId);
    if (!member) throw new PaymentMethodNotFoundError();

    let customerId = member.stripeCustomerId;
    if (!customerId) {
      customerId = await this.gateway.createCustomer(
        member.email,
        `${member.firstName} ${member.lastName}`,
        member.id,
      );
      await this.members.setStripeCustomerId(member.id, customerId);
    }

    const { clientSecret } = await this.gateway.createSetupIntent(customerId);
    return {
      clientSecret,
      customerId,
      ephemeralKeySecret: await this.gateway.createEphemeralKey(customerId),
    };
  }

  /**
   * Set the default card in BOTH places Stripe reads it: the customer's
   * invoice_settings AND the live subscription's default_payment_method
   * (setting only the customer leaves the renewal pinned to the old card).
   * Ownership is verified against the member's own Stripe customer, so a
   * foreign pm_ id 404s instead of moving someone else's card.
   */
  async setDefaultPaymentMethod(memberId: string, stripePaymentMethodId: string): Promise<void> {
    const member = await this.members.getById(memberId);
    if (!member?.stripeCustomerId) throw new PaymentMethodNotFoundError();

    const pm = await this.gateway.getPaymentMethodData(stripePaymentMethodId);
    if (!pm || pm.customerId !== member.stripeCustomerId) throw new PaymentMethodNotFoundError();

    const membership = await this.membershipLookup.getCurrentForMember(memberId);
    const liveSubscriptionId =
      membership && membership.status !== 'canceled' && membership.status !== 'incomplete_expired'
        ? membership.stripeSubscriptionId
        : null;

    await this.gateway.setDefaultPaymentMethod(
      member.stripeCustomerId,
      liveSubscriptionId,
      stripePaymentMethodId,
    );

    // Mirror immediately (webhooks converge later regardless).
    await this.paymentMethods.upsertFromStripe(memberId, pm);
    await this.paymentMethods.setDefault(memberId, stripePaymentMethodId);
  }

  async listPaymentMethods(memberId: string) {
    return this.paymentMethods.listForMember(memberId);
  }
}
