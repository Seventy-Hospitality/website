import { describe, expect, it } from 'vitest';
import type { MembershipSummary } from '../../lib/api';
import {
  billingMonthLabel,
  instantDateLabel,
  memberSinceLabel,
  membershipStatusLine,
} from './account-lib';

/**
 * The venue-local date rendering W6 leans on: ledger months are bucketed
 * in the venue timezone server-side, so every instant label must render in
 * that same zone or a boundary row drifts out of its month header.
 */

describe('instantDateLabel (venue-local)', () => {
  it('renders the instant on the venue calendar, not the device one', () => {
    // 02:00Z on Aug 1 is the evening of Jul 31 in Los Angeles.
    expect(instantDateLabel('2026-08-01T02:00:00.000Z', 'America/Los_Angeles')).toBe(
      'Jul 31, 2026',
    );
    expect(instantDateLabel('2026-08-01T02:00:00.000Z', 'UTC')).toBe('Aug 1, 2026');
    expect(instantDateLabel('2026-08-01T02:00:00.000Z', 'Asia/Tokyo')).toBe('Aug 1, 2026');
  });

  it('keeps a month-boundary charge inside its venue ledger month', () => {
    // The backend buckets this charge into the LA venue's July ledger; the
    // row label must sit inside that month for every viewer.
    expect(billingMonthLabel('2026-07')).toBe('July 2026');
    expect(instantDateLabel('2026-08-01T02:00:00.000Z', 'America/Los_Angeles')).toMatch(
      /Jul \d+, 2026/,
    );
  });
});

describe('memberSinceLabel (venue-local)', () => {
  it('anchors the join month on the venue calendar', () => {
    // 03:00Z on Mar 1 is still February in New York.
    expect(memberSinceLabel('2025-03-01T03:00:00.000Z', 'America/New_York')).toBe(
      'Member since Feb 2025',
    );
    expect(memberSinceLabel('2025-03-01T03:00:00.000Z', 'UTC')).toBe('Member since Mar 2025');
  });
});

describe('membershipStatusLine (venue-local dates)', () => {
  const membership: Pick<
    MembershipSummary,
    'status' | 'currentPeriodEnd' | 'cancelAtPeriodEnd' | 'pendingPlan' | 'pendingPlanEffectiveAt'
  > = {
    status: 'active',
    currentPeriodEnd: '2027-03-12T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    pendingPlan: null,
    pendingPlanEffectiveAt: null,
  };

  it('renders renewal dates on the venue calendar', () => {
    expect(membershipStatusLine(membership, 'UTC')).toBe('Renews Mar 12, 2027');
    // Midnight UTC is the evening of the previous day in New York.
    expect(membershipStatusLine(membership, 'America/New_York')).toBe('Renews Mar 11, 2027');
  });

  it('renders the pending-plan switch date in the same zone', () => {
    expect(
      membershipStatusLine(
        {
          ...membership,
          pendingPlan: { id: 'annual', name: 'Member annual' },
          pendingPlanEffectiveAt: '2027-03-12T00:00:00.000Z',
        },
        'America/New_York',
      ),
    ).toBe('Switches to Member annual on Mar 11, 2027');
  });
});
