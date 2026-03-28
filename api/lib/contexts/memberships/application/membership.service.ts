import {
  membershipInvariants,
  PlanNotFoundError,
  type CheckoutCompletedData,
  type SubscriptionChangedData,
  type SubscriptionDeletedData,
  type InvoiceData,
  resolveCheckoutAction,
  resolveSubscriptionUpdate,
  resolveSubscriptionDeletion,
  resolveInvoiceUpdate,
} from '../domain';
import type { MembershipRepository } from '../infrastructure/membership.repository';
import type { PlanRepository } from '../infrastructure/plan.repository';
import type { StripeGateway } from '../infrastructure/stripe.gateway';

export class MembershipService {
  constructor(
    private readonly membershipRepo: MembershipRepository,
    private readonly planRepo: PlanRepository,
    private readonly stripeGateway: StripeGateway,
  ) {}

  async createCheckoutSession(memberId: string, planId: string, memberEmail: string, memberName: string, stripeCustomerId: string | null) {
    const plan = await this.planRepo.getById(planId);
    if (!plan) throw new PlanNotFoundError(planId);

    const currentMembership = await this.membershipRepo.getByMemberId(memberId);
    membershipInvariants.canStartSubscription(currentMembership);

    // Ensure Stripe customer exists
    let customerId = stripeCustomerId;
    if (!customerId) {
      customerId = await this.stripeGateway.createCustomer(memberEmail, memberName, memberId);
    }

    return this.stripeGateway.createCheckoutSession(customerId, plan.stripePriceId, memberId, planId);
  }

  async createPortalSession(memberId: string, stripeCustomerId: string | null) {
    membershipInvariants.requiresStripeCustomer(stripeCustomerId);
    return this.stripeGateway.createPortalSession(stripeCustomerId!);
  }

  async syncFromStripe(memberId: string, stripeCustomerId: string | null) {
    if (!stripeCustomerId) return null;

    const subData = await this.stripeGateway.getActiveSubscription(stripeCustomerId);
    if (!subData) {
      const existing = await this.membershipRepo.getByMemberId(memberId);
      if (existing) {
        await this.membershipRepo.updateBySubscriptionId(existing.stripeSubscriptionId, { status: 'canceled' });
      }
      return null;
    }

    const plan = await this.planRepo.getByStripePriceId(subData.priceId);
    if (!plan) return null;

    return this.membershipRepo.upsertBySubscriptionId(subData.subscriptionId, {
      memberId,
      planId: plan.id,
      status: subData.status,
      currentPeriodEnd: subData.currentPeriodEnd,
      cancelAtPeriodEnd: subData.cancelAtPeriodEnd,
    });
  }

  // ── Webhook handlers ──

  async handleCheckoutCompleted(data: CheckoutCompletedData) {
    const action = resolveCheckoutAction(data);
    await this.membershipRepo.upsertBySubscriptionId(action.key.stripeSubscriptionId, {
      memberId: action.create.memberId,
      planId: action.create.planId,
      status: action.create.status,
      currentPeriodEnd: action.create.currentPeriodEnd,
      cancelAtPeriodEnd: action.create.cancelAtPeriodEnd,
    });
  }

  async handleSubscriptionUpdated(data: SubscriptionChangedData) {
    const action = resolveSubscriptionUpdate(data);
    const updateData: Record<string, unknown> = { ...action.data };

    if (action.priceId) {
      const plan = await this.planRepo.getByStripePriceId(action.priceId);
      if (plan) updateData.planId = plan.id;
    }

    await this.membershipRepo.updateBySubscriptionId(action.key.stripeSubscriptionId, updateData);
  }

  async handleSubscriptionDeleted(data: SubscriptionDeletedData) {
    const action = resolveSubscriptionDeletion(data);
    await this.membershipRepo.updateBySubscriptionId(action.key.stripeSubscriptionId, action.data);
  }

  async handleInvoicePaid(data: InvoiceData) {
    const action = resolveInvoiceUpdate(data);
    await this.membershipRepo.updateManyBySubscriptionId(action.key.subscriptionId, action.data);
  }

  async handleInvoicePaymentFailed(data: InvoiceData) {
    await this.membershipRepo.updateManyBySubscriptionId(data.subscriptionId, { status: 'past_due' });
  }
}
