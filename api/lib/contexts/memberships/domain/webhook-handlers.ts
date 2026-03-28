import type { MembershipStatus } from './membership';

/** Data extracted from a Stripe webhook event by the infrastructure layer */
export interface CheckoutCompletedData {
  memberId: string;
  planId: string;
  subscriptionId: string;
  status: MembershipStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export interface SubscriptionChangedData {
  subscriptionId: string;
  status: MembershipStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  priceId: string | null;
}

export interface SubscriptionDeletedData {
  subscriptionId: string;
}

export interface InvoiceData {
  subscriptionId: string;
  status: MembershipStatus;
  currentPeriodEnd: Date;
}

/** Determines what DB operation to perform. Pure logic, no side effects. */
export function resolveCheckoutAction(data: CheckoutCompletedData) {
  return {
    type: 'upsert' as const,
    key: { stripeSubscriptionId: data.subscriptionId },
    create: {
      memberId: data.memberId,
      planId: data.planId,
      stripeSubscriptionId: data.subscriptionId,
      status: data.status,
      currentPeriodEnd: data.currentPeriodEnd,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd,
    },
    update: {
      status: data.status,
      currentPeriodEnd: data.currentPeriodEnd,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd,
    },
  };
}

export function resolveSubscriptionUpdate(data: SubscriptionChangedData) {
  return {
    type: 'update' as const,
    key: { stripeSubscriptionId: data.subscriptionId },
    data: {
      status: data.status,
      currentPeriodEnd: data.currentPeriodEnd,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd,
    },
    priceId: data.priceId,
  };
}

export function resolveSubscriptionDeletion(data: SubscriptionDeletedData) {
  return {
    type: 'update' as const,
    key: { stripeSubscriptionId: data.subscriptionId },
    data: { status: 'canceled' as const },
  };
}

export function resolveInvoiceUpdate(data: InvoiceData) {
  return {
    type: 'update' as const,
    key: { subscriptionId: data.subscriptionId },
    data: {
      status: data.status,
      currentPeriodEnd: data.currentPeriodEnd,
    },
  };
}
