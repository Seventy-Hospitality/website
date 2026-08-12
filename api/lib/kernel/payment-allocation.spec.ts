import {
  allocateRefund,
  computeNetPaidCents,
  computeRefundableCents,
  InsufficientRefundableBalanceError,
  type PaymentLike,
} from './payment-allocation';

const T0 = new Date('2026-08-01T12:00:00Z');

function charge(overrides: Partial<PaymentLike> = {}): PaymentLike {
  return {
    kind: 'charge',
    amountCents: 2000,
    status: 'succeeded',
    stripePaymentIntentId: 'pi_1',
    createdAt: T0,
    disputedAt: null,
    ...overrides,
  };
}

function refund(overrides: Partial<PaymentLike> = {}): PaymentLike {
  return {
    kind: 'refund',
    amountCents: 500,
    status: 'succeeded',
    stripePaymentIntentId: 'pi_1',
    createdAt: T0,
    ...overrides,
  };
}

function later(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

describe('computeNetPaidCents', () => {
  it('sums succeeded charges minus succeeded refunds', () => {
    expect(computeNetPaidCents([charge(), refund()])).toBe(1500);
  });

  it('counts PENDING refunds as gone (reserved money is committed to leave)', () => {
    expect(computeNetPaidCents([charge(), refund({ status: 'pending' })])).toBe(1500);
  });

  it('ignores pending and failed charges and failed refunds', () => {
    expect(
      computeNetPaidCents([
        charge({ status: 'pending' }),
        charge({ status: 'failed' }),
        refund({ status: 'failed' }),
      ]),
    ).toBe(0);
  });

  it('still counts a DISPUTED charge as captured money', () => {
    expect(computeNetPaidCents([charge({ disputedAt: T0 })])).toBe(2000);
  });
});

describe('computeRefundableCents', () => {
  it('equals net paid when nothing is disputed', () => {
    expect(computeRefundableCents([charge(), refund()])).toBe(1500);
  });

  it('excludes disputed charges entirely (financial freeze)', () => {
    const rows = [
      charge({ disputedAt: T0 }),
      charge({ amountCents: 1000, stripePaymentIntentId: 'pi_2', createdAt: later(10) }),
    ];
    expect(computeRefundableCents(rows)).toBe(1000);
    expect(computeNetPaidCents(rows)).toBe(3000);
  });
});

describe('allocateRefund', () => {
  it('returns nothing for a zero or negative refund (zero-delta reschedule)', () => {
    expect(allocateRefund([charge()], 0)).toEqual([]);
    expect(allocateRefund([charge()], -100)).toEqual([]);
  });

  it('allocates newest-first across multiple intents', () => {
    const rows = [
      charge({ amountCents: 2000, stripePaymentIntentId: 'pi_1', createdAt: T0 }),
      charge({ amountCents: 1000, stripePaymentIntentId: 'pi_2', createdAt: later(10) }),
    ];
    expect(allocateRefund(rows, 2500)).toEqual([
      { stripePaymentIntentId: 'pi_2', amountCents: 1000 },
      { stripePaymentIntentId: 'pi_1', amountCents: 1500 },
    ]);
  });

  it('caps each intent at its remaining refundable balance', () => {
    const rows = [charge(), refund({ amountCents: 1500 })];
    expect(allocateRefund(rows, 500)).toEqual([{ stripePaymentIntentId: 'pi_1', amountCents: 500 }]);
  });

  it('counts PENDING refunds against balance so concurrent paths fail closed', () => {
    const rows = [charge(), refund({ amountCents: 2000, status: 'pending' })];
    expect(() => allocateRefund(rows, 1)).toThrow(InsufficientRefundableBalanceError);
  });

  it('fails closed when the refund exceeds net paid', () => {
    expect(() => allocateRefund([charge()], 2001)).toThrow(InsufficientRefundableBalanceError);
  });

  it('never allocates against a disputed charge', () => {
    const rows = [
      charge({ disputedAt: T0 }),
      charge({ amountCents: 1000, stripePaymentIntentId: 'pi_2', createdAt: later(10) }),
    ];
    expect(allocateRefund(rows, 1000)).toEqual([{ stripePaymentIntentId: 'pi_2', amountCents: 1000 }]);
    expect(() => allocateRefund(rows, 1001)).toThrow(InsufficientRefundableBalanceError);
  });

  it('carries refund remainders across charges sharing one intent (no over-allocation)', () => {
    // pi_1 funded two charges (100 + 200); 150 already refunded on pi_1.
    // True remaining balance is 150, split 0 (older consumed) + 150.
    const rows = [
      charge({ amountCents: 100, stripePaymentIntentId: 'pi_1', createdAt: T0 }),
      charge({ amountCents: 200, stripePaymentIntentId: 'pi_1', createdAt: later(10) }),
      refund({ amountCents: 150, stripePaymentIntentId: 'pi_1' }),
    ];
    expect(computeRefundableCents(rows)).toBe(150);
    expect(allocateRefund(rows, 150)).toEqual([{ stripePaymentIntentId: 'pi_1', amountCents: 150 }]);
    expect(() => allocateRefund(rows, 151)).toThrow(InsufficientRefundableBalanceError);
  });

  it('spans a large refund across every remaining balance, newest first', () => {
    const rows = [
      charge({ amountCents: 1000, stripePaymentIntentId: 'pi_1', createdAt: T0 }),
      charge({ amountCents: 500, stripePaymentIntentId: 'pi_2', createdAt: later(5) }),
      charge({ amountCents: 250, stripePaymentIntentId: 'pi_3', createdAt: later(10) }),
      refund({ amountCents: 200, stripePaymentIntentId: 'pi_2' }),
    ];
    expect(allocateRefund(rows, 1550)).toEqual([
      { stripePaymentIntentId: 'pi_3', amountCents: 250 },
      { stripePaymentIntentId: 'pi_2', amountCents: 300 },
      { stripePaymentIntentId: 'pi_1', amountCents: 1000 },
    ]);
  });
});
