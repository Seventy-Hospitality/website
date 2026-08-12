import {
  availabilityCountLabel,
  buildDateStrip,
  computeTotalCents,
  formatAmount,
  formatAmountWithCents,
  formatSlotRange,
  formatTimeRangeCompact,
  isContiguous,
  pruneSelection,
  resourceFeeLabel,
  resourceNoun,
  selectionSummary,
  slotsFromRange,
  todayDateKey,
  toggleSlot,
} from '../booking';

describe('slot multi-select (toggleSlot)', () => {
  const dur = 30;

  it('selects the first slot into an empty run', () => {
    expect(toggleSlot([], '20:00', dur)).toEqual(['20:00']);
  });

  it('extends the run at the trailing edge', () => {
    expect(toggleSlot(['20:00'], '20:30', dur)).toEqual(['20:00', '20:30']);
  });

  it('extends the run at the leading edge', () => {
    expect(toggleSlot(['20:30'], '20:00', dur)).toEqual(['20:00', '20:30']);
  });

  it('starts a fresh selection when picking away from the run (no gaps allowed)', () => {
    expect(toggleSlot(['20:00', '20:30'], '22:00', dur)).toEqual(['22:00']);
  });

  it('shrinks from the front when deselecting the first slot', () => {
    expect(toggleSlot(['20:00', '20:30', '21:00'], '20:00', dur)).toEqual(['20:30', '21:00']);
  });

  it('keeps the run up to (excluding) a deselected interior slot', () => {
    expect(toggleSlot(['20:00', '20:30', '21:00'], '20:30', dur)).toEqual(['20:00']);
  });

  it('produces only contiguous selections across a random sequence', () => {
    let sel: string[] = [];
    for (const s of ['20:00', '20:30', '21:00', '20:00']) sel = toggleSlot(sel, s, dur);
    expect(isContiguous(sel, dur)).toBe(true);
  });
});

describe('isContiguous', () => {
  it('accepts a gap-free run and a singleton and empty', () => {
    expect(isContiguous([], 30)).toBe(true);
    expect(isContiguous(['9:00'], 30)).toBe(true);
    expect(isContiguous(['09:00', '09:30', '10:00'], 30)).toBe(true);
  });
  it('rejects a run with a hole', () => {
    expect(isContiguous(['09:00', '10:00'], 30)).toBe(false);
  });
});

describe('pruneSelection', () => {
  it('drops unavailable slots and keeps the longest remaining contiguous run', () => {
    // 09:30 got taken; the run splits, keep the longer tail.
    const kept = pruneSelection(['09:00', '09:30', '10:00', '10:30'], ['09:00', '10:00', '10:30'], 30);
    expect(kept).toEqual(['10:00', '10:30']);
  });
  it('returns empty when nothing survives', () => {
    expect(pruneSelection(['09:00'], ['12:00'], 30)).toEqual([]);
  });
});

describe('slotsFromRange', () => {
  it('rebuilds every 30-min slot the range occupies', () => {
    expect(slotsFromRange('20:00', '21:30', 30)).toEqual(['20:00', '20:30', '21:00']);
  });
});

describe('quote math (computeTotalCents / selectionSummary)', () => {
  it('rounds half-up like the backend', () => {
    // $20/hr for 90 minutes = 3000 cents.
    expect(computeTotalCents(2000, 90)).toBe(3000);
    // $10/hr for 30 minutes = 500 cents.
    expect(computeTotalCents(1000, 30)).toBe(500);
    // Odd rate that would leave a fractional cent rounds to the nearest.
    expect(computeTotalCents(2500, 30)).toBe(1250);
  });

  it('summarizes a selection with edges, duration and preview total', () => {
    const summary = selectionSummary(['20:00', '20:30'], 30, 2000);
    expect(summary).toEqual({
      startLabel: '20:00',
      endLabel: '21:00',
      durationMinutes: 60,
      totalCents: 2000,
    });
  });

  it('is null for an empty selection', () => {
    expect(selectionSummary([], 30, 2000)).toBeNull();
  });
});

describe('venue-timezone today (todayDateKey)', () => {
  // An instant that is still the previous calendar day in New York but the
  // next day in UTC: the two zones disagree on "today", which is exactly why
  // the date strip must anchor on the venue zone, not the device zone.
  const nearMidnight = new Date('2026-08-12T03:30:00.000Z');

  it('reads the date on the venue wall clock', () => {
    expect(todayDateKey('America/New_York', nearMidnight)).toBe('2026-08-11');
  });

  it('differs from the device zone across the midnight boundary', () => {
    expect(todayDateKey('UTC', nearMidnight)).toBe('2026-08-12');
    expect(todayDateKey('America/New_York', nearMidnight)).not.toBe(
      todayDateKey('UTC', nearMidnight),
    );
  });
});

describe('date strip horizon', () => {
  it('runs today first, today + maxAdvanceDays inclusive', () => {
    const strip = buildDateStrip('2026-08-12', 7);
    expect(strip[0]).toBe('2026-08-12');
    expect(strip).toHaveLength(8);
    expect(strip[7]).toBe('2026-08-19');
  });
});

describe('labels', () => {
  it('formats a slot range and a compact range with a shared meridiem', () => {
    expect(formatSlotRange('16:00', 30)).toBe('4:00PM - 4:30PM');
    expect(formatTimeRangeCompact('21:30', '23:30')).toBe('9:30-11:30PM');
    // Crossing the meridiem keeps both.
    expect(formatTimeRangeCompact('11:30', '12:30')).toBe('11:30AM-12:30PM');
  });

  it('pluralizes the amenity noun in the browse count', () => {
    expect(availabilityCountLabel('Badminton Court', 4)).toBe('4 courts available');
    expect(availabilityCountLabel('Tennis Simulator', 1)).toBe('1 simulator available');
    expect(availabilityCountLabel('Shower', 2)).toBe('2 available');
    expect(resourceNoun('Mahjong Table')).toBe('table');
    expect(resourceFeeLabel('Badminton Court')).toBe('Court fee');
  });

  it('formats money with and without cents', () => {
    expect(formatAmount(2000)).toBe('$20');
    expect(formatAmount(2550)).toBe('$25.50');
    expect(formatAmountWithCents(2000)).toBe('$20.00');
    expect(formatAmountWithCents(0)).toBe('$0.00');
  });
});
