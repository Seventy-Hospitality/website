import { describe, expect, it } from 'vitest';
import type { Plan } from './api';
import {
  billingCaption,
  defaultBillingPeriod,
  formatAmount,
  formatAmountWithCents,
  listBillingPeriods,
  periodSuffix,
  planCardsForPeriod,
} from './plan-pricing';

function plan(overrides: Partial<Plan>): Plan {
  return {
    id: 'p1',
    name: 'Membership',
    stripePriceId: 'price_1',
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

// The seeded catalog shape: member monthly + annual, invite-only Pro annual.
const MONTHLY = plan({ id: 'monthly', amountCents: 5000, interval: 'month', sortOrder: 0 });
const ANNUAL = plan({ id: 'annual', amountCents: 24000, interval: 'year', sortOrder: 1 });
const PRO = plan({
  id: 'pro',
  tier: 'pro',
  amountCents: 96000,
  interval: 'year',
  inviteOnly: true,
  sortOrder: 2,
  features: ['Priority booking', 'Premium amenities'],
});

const CATALOG = [MONTHLY, ANNUAL, PRO];

describe('listBillingPeriods', () => {
  it('lists the periods of self-servable plans, month before year', () => {
    expect(listBillingPeriods(CATALOG)).toEqual(['month', 'year']);
  });

  it('ignores periods that exist only on invite-only plans', () => {
    expect(listBillingPeriods([MONTHLY, PRO])).toEqual(['month']);
  });

  it('renders whatever the API returns: a single period stays a single period', () => {
    expect(listBillingPeriods([ANNUAL])).toEqual(['year']);
  });

  it('falls back to all plans when everything is invite-only', () => {
    expect(listBillingPeriods([PRO])).toEqual(['year']);
  });

  it('is empty for an empty catalog', () => {
    expect(listBillingPeriods([])).toEqual([]);
  });
});

describe('defaultBillingPeriod', () => {
  it('defaults to annual when offered (the Figma default)', () => {
    expect(defaultBillingPeriod(CATALOG)).toBe('year');
  });

  it('falls back to the only period on offer', () => {
    expect(defaultBillingPeriod([MONTHLY])).toBe('month');
  });
});

describe('planCardsForPeriod', () => {
  it('re-prices each tier from its row for the selected period', () => {
    const yearCards = planCardsForPeriod(CATALOG, 'year');
    expect(yearCards.map((card) => card.plan.id)).toEqual(['annual', 'pro']);

    const monthCards = planCardsForPeriod(CATALOG, 'month');
    expect(monthCards[0].plan.id).toBe('monthly');
    expect(monthCards[0].matchesPeriod).toBe(true);
  });

  it('keeps a tier visible with its own price when it lacks the selected period', () => {
    const monthCards = planCardsForPeriod(CATALOG, 'month');
    const pro = monthCards.find((card) => card.tier === 'pro');
    expect(pro?.plan.id).toBe('pro');
    expect(pro?.matchesPeriod).toBe(false);
  });

  it('locks tiers that cannot be self-served', () => {
    const cards = planCardsForPeriod(CATALOG, 'year');
    expect(cards.find((card) => card.tier === 'member')?.locked).toBe(false);
    expect(cards.find((card) => card.tier === 'pro')?.locked).toBe(true);
  });

  it('orders cards by catalog sortOrder', () => {
    const cards = planCardsForPeriod([PRO, ANNUAL, MONTHLY], 'year');
    expect(cards.map((card) => card.tier)).toEqual(['member', 'pro']);
  });
});

describe('price formatting', () => {
  it('drops cents on whole-dollar headline prices', () => {
    expect(formatAmount(24000)).toBe('$240');
    expect(formatAmount(5250)).toBe('$52.50');
  });

  it('always shows cents in the order summary', () => {
    expect(formatAmountWithCents(24000)).toBe('$240.00');
    expect(formatAmountWithCents(5250)).toBe('$52.50');
  });

  it('labels the billing period', () => {
    expect(periodSuffix('year')).toBe('/ year');
    expect(periodSuffix('month')).toBe('/ month');
  });

  it('advertises the monthly equivalent on annual plans', () => {
    expect(billingCaption({ amountCents: 24000, interval: 'year' })).toBe(
      '$20 per month, billed annually.',
    );
    expect(billingCaption({ amountCents: 5000, interval: 'month' })).toBe('Billed monthly.');
  });
});
