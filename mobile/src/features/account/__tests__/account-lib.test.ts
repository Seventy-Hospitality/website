import type { MembershipSummary } from '../../../lib/api';
import {
  billingMonthLabel,
  billingMonthSummary,
  canCancelMembership,
  canChangeMembership,
  cardExpiryLabel,
  formatHours,
  formatReasons,
  instantDateLabel,
  isPlanUpgrade,
  membershipStatusLine,
  paymentMethodLabel,
  planChangeKind,
  planChangeSummary,
  transactionAmountLabel,
} from '../account-lib';

const MEMBER_MONTHLY = { tier: 'member', interval: 'month' as const, amountCents: 5000 };
const MEMBER_ANNUAL = { tier: 'member', interval: 'year' as const, amountCents: 48000 };
const PRO_ANNUAL = { tier: 'pro', interval: 'year' as const, amountCents: 96000 };

describe('isPlanUpgrade / planChangeKind (proration direction)', () => {
  it('ranks a higher tier as an upgrade regardless of price', () => {
    expect(isPlanUpgrade(MEMBER_ANNUAL, PRO_ANNUAL)).toBe(true);
    expect(isPlanUpgrade(PRO_ANNUAL, MEMBER_ANNUAL)).toBe(false);
  });

  it('within a tier, month -> year is an upgrade and year -> month a downgrade', () => {
    expect(isPlanUpgrade(MEMBER_MONTHLY, MEMBER_ANNUAL)).toBe(true);
    expect(isPlanUpgrade(MEMBER_ANNUAL, MEMBER_MONTHLY)).toBe(false);
  });

  it('within a tier + interval, a higher price is an upgrade', () => {
    const cheap = { tier: 'member', interval: 'month' as const, amountCents: 3000 };
    expect(isPlanUpgrade(cheap, MEMBER_MONTHLY)).toBe(true);
    expect(isPlanUpgrade(MEMBER_MONTHLY, cheap)).toBe(false);
  });

  it('maps direction to kind and copy', () => {
    expect(planChangeKind(MEMBER_MONTHLY, MEMBER_ANNUAL)).toBe('upgrade');
    expect(planChangeKind(MEMBER_ANNUAL, MEMBER_MONTHLY)).toBe('downgrade');
    expect(planChangeSummary('upgrade', 'Mar 12, 2027')).toMatch(/starts right away/);
    expect(planChangeSummary('downgrade', 'Mar 12, 2027')).toMatch(/starts on Mar 12, 2027/);
    expect(planChangeSummary('downgrade', 'Mar 12, 2027')).toMatch(/not refunded/);
  });
});

describe('money + date formatting', () => {
  it('labels billing months and summaries', () => {
    expect(billingMonthLabel('2026-07')).toBe('July 2026');
    expect(billingMonthLabel('2026-01')).toBe('January 2026');
    expect(billingMonthSummary(5, 19200)).toBe('5 transactions · $192');
    expect(billingMonthSummary(1, -1800)).toBe('1 transaction · -$18');
  });

  it('signs transaction amounts by direction', () => {
    expect(transactionAmountLabel({ direction: 'debit', amountCents: 1800 })).toBe('$18.00');
    expect(transactionAmountLabel({ direction: 'credit', amountCents: 1800 })).toBe('-$18.00');
  });

  it('formats card expiry, hours, and the payment-method line', () => {
    expect(cardExpiryLabel(9, 2027)).toBe('09/27');
    expect(cardExpiryLabel(12, 2030)).toBe('12/30');
    expect(formatHours(888)).toBe('888');
    expect(formatHours(1.5)).toBe('1.5');
    expect(paymentMethodLabel({ brand: 'visa', last4: '4242', expMonth: 9, expYear: 2027 })).toBe(
      '•••• 4242 · exp 09/27',
    );
  });

  it('renders instants in the given venue timezone', () => {
    expect(instantDateLabel('2027-03-12T00:00:00.000Z', 'UTC')).toBe('Mar 12, 2027');
  });
});

describe('membership status line + gates', () => {
  const base: MembershipSummary = {
    id: 'sub_1',
    status: 'active',
    currentPeriodEnd: '2027-03-12T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    plan: { id: 'p1', name: 'Monthly', amountCents: 5000, interval: 'month', tier: 'member' },
    pendingPlan: null,
    pendingPlanEffectiveAt: null,
  };

  it('reports forward-looking state', () => {
    expect(membershipStatusLine(base, 'UTC')).toBe('Renews Mar 12, 2027');
    expect(membershipStatusLine({ ...base, cancelAtPeriodEnd: true }, 'UTC')).toBe('Ends Mar 12, 2027');
    expect(membershipStatusLine({ ...base, status: 'past_due' }, 'UTC')).toBe('Payment past due');
    expect(membershipStatusLine({ ...base, status: 'paused' }, 'UTC')).toBe('Paused');
    expect(
      membershipStatusLine(
        { ...base, pendingPlan: { id: 'p2', name: 'Annual' }, pendingPlanEffectiveAt: '2027-03-12T00:00:00.000Z' },
        'UTC',
      ),
    ).toBe('Switches to Annual on Mar 12, 2027');
  });

  it('gates change to active/trialing and cancel to any live subscription', () => {
    expect(canChangeMembership(base)).toBe(true);
    expect(canChangeMembership({ ...base, status: 'past_due' })).toBe(false);
    expect(canChangeMembership(null)).toBe(false);
    expect(canCancelMembership({ ...base, status: 'past_due' })).toBe(true);
    expect(canCancelMembership({ ...base, status: 'paused' })).toBe(true);
    expect(canCancelMembership({ ...base, status: 'canceled' })).toBe(false);
    expect(canCancelMembership({ ...base, status: 'incomplete_expired' })).toBe(false);
    expect(canCancelMembership(null)).toBe(false);
  });
});

describe('formatReasons', () => {
  it('joins deletion-blocked reasons in prose', () => {
    expect(formatReasons([])).toBe('');
    expect(formatReasons(['an open payment dispute'])).toBe('an open payment dispute');
    expect(formatReasons(['a refund in flight', 'an open dispute'])).toBe(
      'a refund in flight and an open dispute',
    );
    expect(formatReasons(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
