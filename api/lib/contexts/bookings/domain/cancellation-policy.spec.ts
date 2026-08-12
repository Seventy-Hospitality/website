import {
  allocateRefund,
  computeNetPaidCents,
  computeRefundCents,
  computeRescheduleDeltaCents,
  refundPercentFor,
} from './cancellation-policy';
import { InsufficientRefundableBalanceError } from './errors';
import type { ReservationPayment } from './reservation';

function payment(overrides: Partial<ReservationPayment>): Pick<
  ReservationPayment,
  'kind' | 'amountCents' | 'status' | 'stripePaymentIntentId' | 'createdAt'
> {
  return {
    kind: 'charge',
    amountCents: 1000,
    status: 'succeeded',
    stripePaymentIntentId: 'pi_1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('refundPercentFor (tiers: 100% >24h, 50% 2-24h, 0% inside)', () => {
  const startsAt = new Date('2026-07-10T18:00:00Z');

  it('refunds 100% more than 24h out', () => {
    expect(refundPercentFor(startsAt, new Date('2026-07-09T17:59:00Z'))).toBe(100);
  });

  it('refunds 50% at exactly 24h and down to 2h', () => {
    expect(refundPercentFor(startsAt, new Date('2026-07-09T18:00:00Z'))).toBe(50);
    expect(refundPercentFor(startsAt, new Date('2026-07-10T16:00:00Z'))).toBe(50);
  });

  it('refunds nothing inside 2h', () => {
    expect(refundPercentFor(startsAt, new Date('2026-07-10T16:01:00Z'))).toBe(0);
    expect(refundPercentFor(startsAt, new Date('2026-07-10T18:30:00Z'))).toBe(0);
  });
});

describe('computeNetPaidCents', () => {
  it('sums succeeded charges minus succeeded refunds', () => {
    const net = computeNetPaidCents([
      payment({ amountCents: 3000 }),
      payment({ kind: 'refund', amountCents: 500 }),
      payment({ amountCents: 999, status: 'pending' }),
      payment({ kind: 'refund', amountCents: 999, status: 'failed' }),
    ]);
    expect(net).toBe(2500);
  });

  it('counts PENDING refunds as already gone (reserved money, fail closed)', () => {
    const net = computeNetPaidCents([
      payment({ amountCents: 3000 }),
      payment({ kind: 'refund', amountCents: 1000, status: 'pending' }),
    ]);
    expect(net).toBe(2000);
  });
});

describe('computeRefundCents', () => {
  it('floors the tier percentage', () => {
    expect(computeRefundCents(1001, 50)).toBe(500);
    expect(computeRefundCents(3000, 100)).toBe(3000);
    expect(computeRefundCents(3000, 0)).toBe(0);
  });
});

describe('computeRescheduleDeltaCents', () => {
  it('is positive when growing (charge) at the snapshot rate', () => {
    // 90 min at the snapshot 2000/h = 3000; paid 2000 -> charge 1000
    expect(computeRescheduleDeltaCents(90, 2000, 2000)).toBe(1000);
  });

  it('is negative when shrinking (refund)', () => {
    expect(computeRescheduleDeltaCents(30, 2000, 2000)).toBe(-1000);
  });

  it('uses the snapshot rate, not any current catalog rate', () => {
    // Snapshot 2000/h even if the catalog moved to 9999/h.
    expect(computeRescheduleDeltaCents(60, 2000, 2000)).toBe(0);
  });
});

describe('allocateRefund', () => {
  it('allocates against the newest charge first', () => {
    const allocations = allocateRefund(
      [
        payment({ stripePaymentIntentId: 'pi_old', amountCents: 1000, createdAt: new Date('2026-01-01T00:00:00Z') }),
        payment({ stripePaymentIntentId: 'pi_new', amountCents: 500, createdAt: new Date('2026-02-01T00:00:00Z') }),
      ],
      700,
    );
    expect(allocations).toEqual([
      { stripePaymentIntentId: 'pi_new', amountCents: 500 },
      { stripePaymentIntentId: 'pi_old', amountCents: 200 },
    ]);
  });

  it('respects per-charge refundable balance from prior refunds', () => {
    const allocations = allocateRefund(
      [
        payment({ stripePaymentIntentId: 'pi_1', amountCents: 1000 }),
        payment({ kind: 'refund', stripePaymentIntentId: 'pi_1', amountCents: 800 }),
      ],
      200,
    );
    expect(allocations).toEqual([{ stripePaymentIntentId: 'pi_1', amountCents: 200 }]);
  });

  it('fails closed when the refund exceeds the refundable balance', () => {
    expect(() =>
      allocateRefund(
        [
          payment({ stripePaymentIntentId: 'pi_1', amountCents: 1000 }),
          payment({ kind: 'refund', stripePaymentIntentId: 'pi_1', amountCents: 800 }),
        ],
        300,
      ),
    ).toThrow(InsufficientRefundableBalanceError);
  });

  it('treats PENDING refunds as consuming balance (a reserved refund blocks a second one)', () => {
    // The double-refund guard: a concurrent money path reserved 800 but its
    // Stripe call has not completed; a second refund of 300 must fail closed.
    expect(() =>
      allocateRefund(
        [
          payment({ stripePaymentIntentId: 'pi_1', amountCents: 1000 }),
          payment({ kind: 'refund', stripePaymentIntentId: 'pi_1', amountCents: 800, status: 'pending' }),
        ],
        300,
      ),
    ).toThrow(InsufficientRefundableBalanceError);
    expect(
      allocateRefund(
        [
          payment({ stripePaymentIntentId: 'pi_1', amountCents: 1000 }),
          payment({ kind: 'refund', stripePaymentIntentId: 'pi_1', amountCents: 800, status: 'pending' }),
        ],
        200,
      ),
    ).toEqual([{ stripePaymentIntentId: 'pi_1', amountCents: 200 }]);
  });

  it('never allocates against a merely pending charge', () => {
    expect(() => allocateRefund([payment({ status: 'pending' })], 100)).toThrow(
      InsufficientRefundableBalanceError,
    );
  });

  it('returns nothing for a non-positive refund', () => {
    expect(allocateRefund([payment({})], 0)).toEqual([]);
  });
});
