import {
  isEntitledStatus,
  isPlanUpgrade,
  membershipInvariants,
  normalizeSubscriptionStatus,
  pickCurrentMembership,
  MembershipError,
  type Plan,
} from './membership';
import { resolveSubscriptionApply } from './webhook-handlers';

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_m',
    name: 'Monthly',
    stripePriceId: 'price_m',
    stripeProductId: 'prod_1',
    amountCents: 5000,
    interval: 'month',
    tier: 'member',
    inviteOnly: false,
    features: [],
    sortOrder: 0,
    active: true,
    ...overrides,
  };
}

describe('normalizeSubscriptionStatus', () => {
  it('passes known statuses through', () => {
    for (const status of ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(normalizeSubscriptionStatus(status)).toEqual({ status, recognized: true });
    }
  });

  it('maps an unknown future status fail-closed to unpaid and flags it', () => {
    expect(normalizeSubscriptionStatus('quantum')).toEqual({ status: 'unpaid', recognized: false });
  });
});

describe('isEntitledStatus', () => {
  it('entitles active and trialing only', () => {
    expect(isEntitledStatus('active')).toBe(true);
    expect(isEntitledStatus('trialing')).toBe(true);
    for (const status of ['past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(isEntitledStatus(status)).toBe(false);
    }
  });
});

describe('pickCurrentMembership', () => {
  const row = (status: string, end: string, id = status) => ({
    id,
    status,
    currentPeriodEnd: new Date(end),
  });

  it('returns null with no rows', () => {
    expect(pickCurrentMembership([])).toBeNull();
  });

  it('prefers an entitled row over anything else', () => {
    const rows = [row('canceled', '2027-01-01'), row('active', '2026-09-01'), row('past_due', '2026-12-01')];
    expect(pickCurrentMembership(rows)!.id).toBe('active');
  });

  it('prefers past_due over mid-purchase and dead rows (re-subscribe history)', () => {
    const rows = [row('canceled', '2026-01-01'), row('incomplete', '2026-09-01'), row('past_due', '2026-08-01')];
    expect(pickCurrentMembership(rows)!.id).toBe('past_due');
  });

  it('breaks ties within a rank by latest period end', () => {
    const rows = [row('canceled', '2025-01-01', 'old'), row('canceled', '2026-01-01', 'new')];
    expect(pickCurrentMembership(rows)!.id).toBe('new');
  });
});

describe('isPlanUpgrade', () => {
  it('tier raise is an upgrade regardless of price or interval', () => {
    expect(isPlanUpgrade(plan(), plan({ tier: 'pro', amountCents: 100 }))).toBe(true);
    expect(isPlanUpgrade(plan({ tier: 'pro' }), plan({ amountCents: 999999 }))).toBe(false);
  });

  it('monthly -> annual at the same tier is an upgrade; the reverse is not', () => {
    expect(isPlanUpgrade(plan(), plan({ interval: 'year', amountCents: 48000 }))).toBe(true);
    expect(isPlanUpgrade(plan({ interval: 'year', amountCents: 48000 }), plan())).toBe(false);
  });

  it('same tier and interval compares price', () => {
    expect(isPlanUpgrade(plan(), plan({ amountCents: 6000 }))).toBe(true);
    expect(isPlanUpgrade(plan({ amountCents: 6000 }), plan())).toBe(false);
  });
});

describe('membershipInvariants.canStartSubscription', () => {
  it('blocks while entitled or collecting', () => {
    for (const status of ['active', 'trialing', 'past_due'] as const) {
      expect(() => membershipInvariants.canStartSubscription({ status })).toThrow(MembershipError);
    }
  });

  it('allows after cancellation, expiry or with no membership', () => {
    for (const status of ['canceled', 'incomplete', 'incomplete_expired', 'unpaid'] as const) {
      expect(() => membershipInvariants.canStartSubscription({ status })).not.toThrow();
    }
    expect(() => membershipInvariants.canStartSubscription(null)).not.toThrow();
  });
});

describe('resolveSubscriptionApply', () => {
  const snapshot = (status: string) => ({ status }) as { status: any };

  it('applies when the plan resolves and a row exists', () => {
    expect(
      resolveSubscriptionApply({ snapshot: snapshot('canceled'), hasExistingRow: true, planId: 'p', memberId: null }),
    ).toEqual({ action: 'apply' });
  });

  it('never creates a row for a dead subscription (no resurrection)', () => {
    for (const status of ['canceled', 'incomplete_expired']) {
      expect(
        resolveSubscriptionApply({ snapshot: snapshot(status), hasExistingRow: false, planId: 'p', memberId: 'm' }),
      ).toEqual({ action: 'skip_dead' });
    }
  });

  it('refuses to apply an unknown price (dashboard-changed plan must alert)', () => {
    expect(
      resolveSubscriptionApply({ snapshot: snapshot('active'), hasExistingRow: true, planId: null, memberId: 'm' }),
    ).toEqual({ action: 'skip_unknown_plan' });
  });

  it('refuses to create without a resolvable member', () => {
    expect(
      resolveSubscriptionApply({ snapshot: snapshot('active'), hasExistingRow: false, planId: 'p', memberId: null }),
    ).toEqual({ action: 'skip_no_member' });
  });
});
