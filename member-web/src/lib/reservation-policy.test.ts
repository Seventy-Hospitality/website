import { describe, expect, it } from 'vitest';
import {
  applyParticipantResponse,
  cancelRefundPreview,
  computeRefundCents,
  describeRescheduleMoney,
  hasReservationStarted,
  isSelectionChanged,
  mergeOwnSlots,
  refundPercentFor,
  reservationSlots,
} from './reservation-policy';

const NOW = new Date('2026-07-06T12:00:00.000Z');

function startingIn(hours: number): Date {
  return new Date(NOW.getTime() + hours * 3_600_000);
}

describe('refundPercentFor (mirror of the backend cancellation tiers)', () => {
  it('refunds 100% more than 24h before start', () => {
    expect(refundPercentFor(startingIn(25), NOW)).toBe(100);
    expect(refundPercentFor(startingIn(24.01), NOW)).toBe(100);
  });

  it('refunds 50% between 2 and 24 hours before start (inclusive edges)', () => {
    expect(refundPercentFor(startingIn(24), NOW)).toBe(50);
    expect(refundPercentFor(startingIn(12), NOW)).toBe(50);
    expect(refundPercentFor(startingIn(2), NOW)).toBe(50);
  });

  it('refunds nothing inside 2 hours or after start', () => {
    expect(refundPercentFor(startingIn(1.99), NOW)).toBe(0);
    expect(refundPercentFor(startingIn(0), NOW)).toBe(0);
    expect(refundPercentFor(startingIn(-1), NOW)).toBe(0);
  });
});

describe('computeRefundCents', () => {
  it('floors to integer cents like the backend', () => {
    expect(computeRefundCents(12000, 50)).toBe(6000);
    expect(computeRefundCents(4001, 50)).toBe(2000);
    expect(computeRefundCents(12000, 0)).toBe(0);
  });
});

describe('cancelRefundPreview', () => {
  it('combines the tier with the net paid amount', () => {
    const preview = cancelRefundPreview(
      { startsAt: startingIn(12).toISOString(), amountPaidCents: 12000 },
      NOW,
    );
    expect(preview).toEqual({ percent: 50, netPaidCents: 12000, refundCents: 6000 });
  });

  it('previews a full refund outside 24h and zero inside 2h', () => {
    expect(
      cancelRefundPreview({ startsAt: startingIn(48).toISOString(), amountPaidCents: 9000 }, NOW)
        .refundCents,
    ).toBe(9000);
    expect(
      cancelRefundPreview({ startsAt: startingIn(1).toISOString(), amountPaidCents: 9000 }, NOW)
        .refundCents,
    ).toBe(0);
  });
});

describe('applyParticipantResponse (mirror of the backend state machine)', () => {
  it('accept: pending -> confirmed, confirmed stays confirmed', () => {
    expect(applyParticipantResponse('pending', 'accept')).toBe('confirmed');
    expect(applyParticipantResponse('confirmed', 'accept')).toBe('confirmed');
  });

  it('decline: pending -> declined, confirmed -> withdrawn (withdraw)', () => {
    expect(applyParticipantResponse('pending', 'decline')).toBe('declined');
    expect(applyParticipantResponse('confirmed', 'decline')).toBe('withdrawn');
  });

  it('decline is idempotent on declined/withdrawn', () => {
    expect(applyParticipantResponse('declined', 'decline')).toBe('declined');
    expect(applyParticipantResponse('withdrawn', 'decline')).toBe('withdrawn');
  });

  it('accept after declining/withdrawing is invalid (needs a re-invite)', () => {
    expect(applyParticipantResponse('declined', 'accept')).toBeNull();
    expect(applyParticipantResponse('withdrawn', 'accept')).toBeNull();
  });
});

const RESERVATION = { date: '2026-07-06', startTime: '21:30', endTime: '22:30' };

describe('reservationSlots / isSelectionChanged (the edit dirty check)', () => {
  it('rebuilds the slots the reservation occupies', () => {
    expect(reservationSlots(RESERVATION, 30)).toEqual(['21:30', '22:00']);
  });

  it('is clean for the reservation\'s own date and slots, in any order', () => {
    expect(isSelectionChanged(RESERVATION, '2026-07-06', ['21:30', '22:00'], 30)).toBe(false);
    expect(isSelectionChanged(RESERVATION, '2026-07-06', ['22:00', '21:30'], 30)).toBe(false);
  });

  it('is dirty when the date, the slots, or the duration change', () => {
    expect(isSelectionChanged(RESERVATION, '2026-07-07', ['21:30', '22:00'], 30)).toBe(true);
    expect(isSelectionChanged(RESERVATION, '2026-07-06', ['21:00', '21:30'], 30)).toBe(true);
    expect(isSelectionChanged(RESERVATION, '2026-07-06', ['21:30'], 30)).toBe(true);
    expect(
      isSelectionChanged(RESERVATION, '2026-07-06', ['21:30', '22:00', '22:30'], 30),
    ).toBe(true);
  });

  it('never reports an empty selection as a change (Continue stays off)', () => {
    expect(isSelectionChanged(RESERVATION, '2026-07-07', [], 30)).toBe(false);
  });
});

describe('mergeOwnSlots', () => {
  it('merges the reservation\'s own slots into availability, sorted, deduped', () => {
    expect(mergeOwnSlots(['20:00', '22:00'], ['21:30', '22:00'])).toEqual([
      '20:00',
      '21:30',
      '22:00',
    ]);
  });
});

describe('describeRescheduleMoney (refund vs charge branch)', () => {
  it('positive delta is an incremental charge due today', () => {
    expect(
      describeRescheduleMoney({ deltaCents: 6000, netPaidCents: 12000, newTotalCents: 18000 }),
    ).toEqual({
      kind: 'charge',
      dueTodayCents: 6000,
      refundCents: 0,
      netPaidCents: 12000,
      newTotalCents: 18000,
    });
  });

  it('negative delta is a refund with nothing due today', () => {
    expect(
      describeRescheduleMoney({ deltaCents: -3000, netPaidCents: 12000, newTotalCents: 9000 }),
    ).toEqual({
      kind: 'refund',
      dueTodayCents: 0,
      refundCents: 3000,
      netPaidCents: 12000,
      newTotalCents: 9000,
    });
  });

  it('zero delta moves no money', () => {
    expect(
      describeRescheduleMoney({ deltaCents: 0, netPaidCents: 12000, newTotalCents: 12000 }),
    ).toEqual({
      kind: 'even',
      dueTodayCents: 0,
      refundCents: 0,
      netPaidCents: 12000,
      newTotalCents: 12000,
    });
  });
});

describe('hasReservationStarted', () => {
  it('flips exactly at the start instant', () => {
    expect(hasReservationStarted({ startsAt: startingIn(0.5).toISOString() }, NOW)).toBe(false);
    expect(hasReservationStarted({ startsAt: NOW.toISOString() }, NOW)).toBe(true);
    expect(hasReservationStarted({ startsAt: startingIn(-1).toISOString() }, NOW)).toBe(true);
  });
});
