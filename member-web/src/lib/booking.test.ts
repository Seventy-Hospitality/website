import { describe, expect, it } from 'vitest';
import {
  addDaysToDateKey,
  availabilityCountLabel,
  buildDateStrip,
  computeTotalCents,
  formatDuration,
  formatSlotRange,
  formatSlotTime,
  formatStripDay,
  formatTimeRangeCompact,
  isContiguous,
  minutesToTimeLabel,
  pruneSelection,
  selectionSummary,
  slotsFromRange,
  timeLabelToMinutes,
  todayDateKey,
  toggleSlot,
} from './booking';

const STEP = 30;

describe('wall-clock labels', () => {
  it('round-trips labels through minutes, including past-midnight hours', () => {
    expect(timeLabelToMinutes('09:00')).toBe(540);
    expect(timeLabelToMinutes('24:30')).toBe(1470);
    expect(minutesToTimeLabel(540)).toBe('09:00');
    expect(minutesToTimeLabel(1470)).toBe('24:30');
  });

  it('formats slot times in the Figma 12-hour style', () => {
    expect(formatSlotTime('16:00')).toBe('4:00PM');
    expect(formatSlotTime('00:30')).toBe('12:30AM');
    expect(formatSlotTime('12:00')).toBe('12:00PM');
    // 24:30 is 00:30 the next day.
    expect(formatSlotTime('24:30')).toBe('12:30AM');
  });

  it('formats slot rows and compact ranges', () => {
    expect(formatSlotRange('16:00', STEP)).toBe('4:00PM - 4:30PM');
    expect(formatTimeRangeCompact('21:30', '23:30')).toBe('9:30-11:30PM');
    expect(formatTimeRangeCompact('11:00', '13:00')).toBe('11:00AM-1:00PM');
  });
});

describe('todayDateKey (venue wall clock)', () => {
  it('computes the date key in the given zone, not the device zone', () => {
    // 03:30Z on Aug 12: Tokyo is already on Aug 12, New York still on Aug 11.
    const now = new Date('2026-08-12T03:30:00Z');
    expect(todayDateKey('America/New_York', now)).toBe('2026-08-11');
    expect(todayDateKey('Asia/Tokyo', now)).toBe('2026-08-12');
    expect(todayDateKey('UTC', now)).toBe('2026-08-12');
  });

  it('splits browser-local and venue-local across the venue midnight', () => {
    // Just before UTC midnight on Jul 31: a UTC device says Jul 31 while a
    // Tokyo venue is already past midnight into Aug 1; a New York venue is
    // mid-evening Jul 31. The strip must follow the venue, month boundary
    // included.
    const nearMidnight = new Date('2026-07-31T23:30:00Z');
    expect(todayDateKey('Asia/Tokyo', nearMidnight)).toBe('2026-08-01');
    expect(todayDateKey('America/New_York', nearMidnight)).toBe('2026-07-31');
    expect(buildDateStrip(todayDateKey('Asia/Tokyo', nearMidnight), 1)).toEqual([
      '2026-08-01',
      '2026-08-02',
    ]);
  });
});

describe('date strip', () => {
  it('builds the horizon from today inclusive', () => {
    expect(buildDateStrip('2026-07-06', 2)).toEqual(['2026-07-06', '2026-07-07', '2026-07-08']);
  });

  it('crosses month boundaries', () => {
    expect(addDaysToDateKey('2026-07-31', 1)).toBe('2026-08-01');
  });

  it('formats strip tiles', () => {
    // 2026-07-06 is a Monday.
    expect(formatStripDay('2026-07-06')).toEqual({ weekday: 'MON', day: '6' });
  });
});

describe('toggleSlot (contiguous multi-select)', () => {
  it('selects the first slot', () => {
    expect(toggleSlot([], '21:30', STEP)).toEqual(['21:30']);
  });

  it('extends the run at either end', () => {
    expect(toggleSlot(['21:30'], '22:00', STEP)).toEqual(['21:30', '22:00']);
    expect(toggleSlot(['21:30', '22:00'], '21:00', STEP)).toEqual(['21:00', '21:30', '22:00']);
  });

  it('restarts the selection when the tapped slot is not adjacent', () => {
    expect(toggleSlot(['21:30', '22:00'], '16:00', STEP)).toEqual(['16:00']);
  });

  it('shrinks from the front when the first slot is deselected', () => {
    expect(toggleSlot(['21:00', '21:30', '22:00'], '21:00', STEP)).toEqual(['21:30', '22:00']);
  });

  it('keeps the head of the run when a middle or last slot is deselected', () => {
    expect(toggleSlot(['21:00', '21:30', '22:00'], '21:30', STEP)).toEqual(['21:00']);
    expect(toggleSlot(['21:00', '21:30', '22:00'], '22:00', STEP)).toEqual(['21:00', '21:30']);
  });

  it('never produces a gap', () => {
    let selection: string[] = [];
    for (const tap of ['21:30', '22:00', '16:00', '16:30', '17:00', '16:30', '16:00']) {
      selection = toggleSlot(selection, tap, STEP);
      expect(isContiguous(selection, STEP)).toBe(true);
    }
  });
});

describe('pruneSelection', () => {
  it('drops slots that are no longer available', () => {
    expect(pruneSelection(['21:00', '21:30'], ['21:30', '22:00'], STEP)).toEqual(['21:30']);
  });

  it('keeps the longest contiguous run when the removal splits the selection', () => {
    expect(
      pruneSelection(['21:00', '21:30', '22:00', '22:30'], ['21:00', '22:00', '22:30'], STEP),
    ).toEqual(['22:00', '22:30']);
  });

  it('keeps everything when the selection is still bookable', () => {
    expect(pruneSelection(['21:00', '21:30'], ['21:00', '21:30', '22:00'], STEP)).toEqual([
      '21:00',
      '21:30',
    ]);
  });
});

describe('slotsFromRange', () => {
  it('rebuilds the slot labels a reservation occupies', () => {
    expect(slotsFromRange('21:30', '23:30', STEP)).toEqual(['21:30', '22:00', '22:30', '23:00']);
  });
});

describe('price recompute', () => {
  it('mirrors the backend rounding', () => {
    expect(computeTotalCents(6000, 120)).toBe(12000);
    expect(computeTotalCents(6000, 30)).toBe(3000);
    // Half-up on odd boundaries.
    expect(computeTotalCents(5555, 30)).toBe(2778);
  });

  it('summarizes a selection with edges, duration, and total', () => {
    expect(selectionSummary(['22:00', '21:30'], STEP, 6000)).toEqual({
      startLabel: '21:30',
      endLabel: '22:30',
      durationMinutes: 60,
      totalCents: 6000,
    });
  });

  it('recomputes as the selection changes and is null when empty', () => {
    let selection = ['21:30'];
    expect(selectionSummary(selection, STEP, 6000)?.totalCents).toBe(3000);
    selection = toggleSlot(selection, '22:00', STEP);
    expect(selectionSummary(selection, STEP, 6000)?.totalCents).toBe(6000);
    selection = toggleSlot(selection, '21:30', STEP);
    expect(selectionSummary(selection, STEP, 6000)?.totalCents).toBe(3000);
    expect(selectionSummary([], STEP, 6000)).toBeNull();
  });
});

describe('labels', () => {
  it('formats durations', () => {
    expect(formatDuration(120)).toBe('2 hours');
    expect(formatDuration(60)).toBe('1 hour');
    expect(formatDuration(90)).toBe('90 min');
  });

  it('derives availability-count subtitles from the type name', () => {
    expect(availabilityCountLabel('Badminton Court', 4)).toBe('4 courts available');
    expect(availabilityCountLabel('Tennis Simulator', 1)).toBe('1 simulator available');
    expect(availabilityCountLabel('Shower', 2)).toBe('2 available');
  });
});
