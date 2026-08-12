import {
  applyParticipantResponse,
  cancelRefundPreview,
  computeRefundCents,
  describeRescheduleMoney,
  isSelectionChanged,
  refundPercentFor,
  reservationMatchesMove,
  reservationSlots,
  selectionTarget,
} from '../reservation-policy';

// ── Participant response state machine (mirror of the backend) ──

describe('applyParticipantResponse', () => {
  it('pending + accept -> confirmed', () => {
    expect(applyParticipantResponse('pending', 'accept')).toBe('confirmed');
  });
  it('pending + decline -> declined', () => {
    expect(applyParticipantResponse('pending', 'decline')).toBe('declined');
  });
  it('confirmed + decline -> withdrawn (withdraw after accept)', () => {
    expect(applyParticipantResponse('confirmed', 'decline')).toBe('withdrawn');
  });
  it('confirmed + accept -> confirmed (idempotent)', () => {
    expect(applyParticipantResponse('confirmed', 'accept')).toBe('confirmed');
  });
  it('declined + decline / withdrawn + decline are idempotent', () => {
    expect(applyParticipantResponse('declined', 'decline')).toBe('declined');
    expect(applyParticipantResponse('withdrawn', 'decline')).toBe('withdrawn');
  });
  it('declined / withdrawn + accept are invalid (need a re-invite)', () => {
    expect(applyParticipantResponse('declined', 'accept')).toBeNull();
    expect(applyParticipantResponse('withdrawn', 'accept')).toBeNull();
  });
});

// ── Cancellation refund tiers ──

describe('cancellation refund tiers', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('more than 24h before start refunds 100%', () => {
    expect(refundPercentFor(new Date('2026-08-22T12:00:00.000Z'), now)).toBe(100);
  });
  it('between 2 and 24h before start refunds 50%', () => {
    expect(refundPercentFor(new Date('2026-08-20T18:00:00.000Z'), now)).toBe(50);
    // Exactly 2h is still the 50% tier (>=).
    expect(refundPercentFor(new Date('2026-08-20T14:00:00.000Z'), now)).toBe(50);
  });
  it('inside 2h (or started) refunds 0%', () => {
    expect(refundPercentFor(new Date('2026-08-20T13:30:00.000Z'), now)).toBe(0);
    expect(refundPercentFor(new Date('2026-08-20T11:00:00.000Z'), now)).toBe(0);
  });

  it('computeRefundCents floors at integer cents', () => {
    expect(computeRefundCents(9001, 50)).toBe(4500); // 4500.5 -> 4500
    expect(computeRefundCents(9000, 100)).toBe(9000);
    expect(computeRefundCents(9000, 0)).toBe(0);
  });

  it('cancelRefundPreview combines tier and net paid', () => {
    const base = { amountPaidCents: 9000 };
    expect(cancelRefundPreview({ ...base, startsAt: '2026-08-22T12:00:00.000Z' }, now)).toEqual({
      percent: 100,
      netPaidCents: 9000,
      refundCents: 9000,
    });
    expect(cancelRefundPreview({ ...base, startsAt: '2026-08-20T18:00:00.000Z' }, now)).toEqual({
      percent: 50,
      netPaidCents: 9000,
      refundCents: 4500,
    });
    expect(cancelRefundPreview({ ...base, startsAt: '2026-08-20T13:00:00.000Z' }, now)).toEqual({
      percent: 0,
      netPaidCents: 9000,
      refundCents: 0,
    });
  });

  it('clamps a negative net paid to zero', () => {
    const preview = cancelRefundPreview(
      { amountPaidCents: -500, startsAt: '2026-08-22T12:00:00.000Z' },
      now,
    );
    expect(preview.netPaidCents).toBe(0);
    expect(preview.refundCents).toBe(0);
  });
});

// ── Reschedule money branch (refund vs charge vs even) ──

describe('describeRescheduleMoney', () => {
  it('positive delta is a charge collected today', () => {
    expect(
      describeRescheduleMoney({ deltaCents: 3000, netPaidCents: 6000, newTotalCents: 9000 }),
    ).toEqual({ kind: 'charge', dueTodayCents: 3000, refundCents: 0, netPaidCents: 6000, newTotalCents: 9000 });
  });
  it('negative delta is a refund to the card', () => {
    expect(
      describeRescheduleMoney({ deltaCents: -3000, netPaidCents: 12000, newTotalCents: 9000 }),
    ).toEqual({ kind: 'refund', dueTodayCents: 0, refundCents: 3000, netPaidCents: 12000, newTotalCents: 9000 });
  });
  it('zero delta is even (applied with no money movement)', () => {
    expect(
      describeRescheduleMoney({ deltaCents: 0, netPaidCents: 9000, newTotalCents: 9000 }),
    ).toEqual({ kind: 'even', dueTodayCents: 0, refundCents: 0, netPaidCents: 9000, newTotalCents: 9000 });
  });
});

// ── Edit dirty-check ──

describe('isSelectionChanged (edit dirty-check)', () => {
  const reservation = { date: '2026-08-20', startTime: '20:00', endTime: '21:00' };
  const dur = 30;

  it('same date + same slots is not a change', () => {
    expect(isSelectionChanged(reservation, '2026-08-20', ['20:00', '20:30'], dur)).toBe(false);
  });
  it('an empty selection is never a change', () => {
    expect(isSelectionChanged(reservation, '2026-08-20', [], dur)).toBe(false);
  });
  it('a different slot on the same date is a change', () => {
    expect(isSelectionChanged(reservation, '2026-08-20', ['20:30', '21:00'], dur)).toBe(true);
  });
  it('a different slot count on the same date is a change', () => {
    expect(isSelectionChanged(reservation, '2026-08-20', ['20:00', '20:30', '21:00'], dur)).toBe(true);
  });
  it('a different date is a change', () => {
    expect(isSelectionChanged(reservation, '2026-08-21', ['20:00', '20:30'], dur)).toBe(true);
  });
  it('slot order does not matter', () => {
    expect(isSelectionChanged(reservation, '2026-08-20', ['20:30', '20:00'], dur)).toBe(false);
  });
});

// ── Move target + match ──

describe('selectionTarget / reservationMatchesMove', () => {
  it('a contiguous selection covers start..end', () => {
    expect(selectionTarget('2026-08-20', ['20:00', '20:30', '21:00'], 30)).toEqual({
      date: '2026-08-20',
      startTime: '20:00',
      endTime: '21:30',
    });
  });
  it('an empty selection has no target', () => {
    expect(selectionTarget('2026-08-20', [], 30)).toBeNull();
  });
  it('reservationSlots rebuilds the occupied labels', () => {
    expect(reservationSlots({ startTime: '20:00', endTime: '21:00' }, 30)).toEqual(['20:00', '20:30']);
  });
  it('matches only when the reservation sits exactly on the move', () => {
    const target = { date: '2026-08-20', startTime: '20:00', endTime: '21:30' };
    expect(
      reservationMatchesMove({ date: '2026-08-20', startTime: '20:00', endTime: '21:30' }, target),
    ).toBe(true);
    expect(
      reservationMatchesMove({ date: '2026-08-20', startTime: '20:00', endTime: '21:00' }, target),
    ).toBe(false);
  });
});
