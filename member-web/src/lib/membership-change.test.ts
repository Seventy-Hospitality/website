import { describe, expect, it } from 'vitest';
import {
  isPlanUpgrade,
  planChangeKind,
  planChangeSummary,
  type ChangeablePlan,
} from './membership-change';

/**
 * The client mirror of the backend's isPlanUpgrade must agree with
 * memberships/domain/membership.ts exactly: tier outranks interval
 * outranks price, and annual beats monthly at the same tier.
 */

function plan(overrides: Partial<ChangeablePlan> = {}): ChangeablePlan {
  return { id: 'p', tier: 'member', interval: 'month', amountCents: 5000, ...overrides };
}

describe('isPlanUpgrade', () => {
  it('ranks a tier change above everything else', () => {
    // Moving to pro is an upgrade even when it is cheaper and monthly.
    expect(
      isPlanUpgrade(
        plan({ interval: 'year', amountCents: 24000 }),
        plan({ tier: 'pro', amountCents: 1000 }),
      ),
    ).toBe(true);
    expect(
      isPlanUpgrade(plan({ tier: 'pro' }), plan({ interval: 'year', amountCents: 99000 })),
    ).toBe(false);
  });

  it('treats monthly -> annual at the same tier as an upgrade', () => {
    expect(isPlanUpgrade(plan(), plan({ interval: 'year', amountCents: 24000 }))).toBe(true);
    expect(isPlanUpgrade(plan({ interval: 'year', amountCents: 24000 }), plan())).toBe(false);
  });

  it('compares price only at the same tier and interval', () => {
    expect(isPlanUpgrade(plan(), plan({ amountCents: 6000 }))).toBe(true);
    expect(isPlanUpgrade(plan({ amountCents: 6000 }), plan())).toBe(false);
    expect(isPlanUpgrade(plan(), plan())).toBe(false);
  });
});

describe('planChangeSummary', () => {
  it('describes an upgrade as immediate with a prorated charge', () => {
    expect(planChangeSummary(planChangeKind(plan(), plan({ interval: 'year', amountCents: 24000 })), 'Sep 1, 2026')).toMatch(
      /starts right away.*prorated/i,
    );
  });

  it('describes a downgrade as scheduled for the period end, no refund', () => {
    const summary = planChangeSummary(
      planChangeKind(plan({ interval: 'year', amountCents: 24000 }), plan()),
      'Sep 1, 2026',
    );
    expect(summary).toContain('starts on Sep 1, 2026');
    expect(summary).toMatch(/not refunded/i);
  });
});
