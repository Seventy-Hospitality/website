import {
  resolveCheckoutAction,
  resolveSubscriptionUpdate,
  resolveSubscriptionDeletion,
  resolveInvoiceUpdate,
} from './webhook-handlers';

describe('resolveCheckoutAction', () => {
  it('returns upsert with correct create and update data', () => {
    const periodEnd = new Date('2025-12-31');
    const result = resolveCheckoutAction({
      memberId: 'mbr_1',
      planId: 'plan_1',
      subscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });

    expect(result.type).toBe('upsert');
    expect(result.key).toEqual({ stripeSubscriptionId: 'sub_1' });
    expect(result.create).toEqual({
      memberId: 'mbr_1',
      planId: 'plan_1',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });
    expect(result.update).toEqual({
      status: 'active',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });
  });
});

describe('resolveSubscriptionUpdate', () => {
  it('returns update keyed by subscription ID', () => {
    const periodEnd = new Date('2025-12-31');
    const result = resolveSubscriptionUpdate({
      subscriptionId: 'sub_1',
      status: 'past_due',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      priceId: 'price_123',
    });

    expect(result.type).toBe('update');
    expect(result.key).toEqual({ stripeSubscriptionId: 'sub_1' });
    expect(result.data.status).toBe('past_due');
    expect(result.priceId).toBe('price_123');
  });

  it('handles null priceId', () => {
    const result = resolveSubscriptionUpdate({
      subscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: true,
      priceId: null,
    });

    expect(result.priceId).toBeNull();
    expect(result.data.cancelAtPeriodEnd).toBe(true);
  });
});

describe('resolveSubscriptionDeletion', () => {
  it('sets status to canceled', () => {
    const result = resolveSubscriptionDeletion({ subscriptionId: 'sub_1' });

    expect(result.type).toBe('update');
    expect(result.key).toEqual({ stripeSubscriptionId: 'sub_1' });
    expect(result.data.status).toBe('canceled');
  });
});

describe('resolveInvoiceUpdate', () => {
  it('returns update with status and period end', () => {
    const periodEnd = new Date('2026-01-31');
    const result = resolveInvoiceUpdate({
      subscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: periodEnd,
    });

    expect(result.type).toBe('update');
    expect(result.data.status).toBe('active');
    expect(result.data.currentPeriodEnd).toBe(periodEnd);
  });
});
