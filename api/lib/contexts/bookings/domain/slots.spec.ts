import { wallTimeToUtc } from '@/lib/kernel';
import {
  computeTotalCents,
  freeSlotStartsByResource,
  generateSlotStarts,
  parseSlotSelection,
  resourcesFreeForSelection,
  selectionToRange,
  unionSlotStarts,
  type ClaimRange,
  type SlotGridConfig,
} from './slots';
import { InvalidSlotSelectionError, OutsideOperatingHoursError } from './errors';

const NY = 'America/New_York';
const CONFIG: SlotGridConfig = { slotDurationMinutes: 30, opStartMinutes: 7 * 60, opEndMinutes: 22 * 60 };

function claim(resourceId: string, dateKey: string, fromMinutes: number, toMinutes: number): ClaimRange {
  return {
    resourceId,
    startsAt: wallTimeToUtc(dateKey, fromMinutes, NY),
    endsAt: wallTimeToUtc(dateKey, toMinutes, NY),
  };
}

describe('slot grid', () => {
  it('generates the operating-hours grid', () => {
    const starts = generateSlotStarts(CONFIG);
    expect(starts[0]).toBe(7 * 60);
    expect(starts[starts.length - 1]).toBe(21 * 60 + 30); // last slot ends at 22:00
    expect(starts).toHaveLength(30);
  });

  it('generates past-midnight slots when hours extend beyond 1440', () => {
    const config: SlotGridConfig = { slotDurationMinutes: 30, opStartMinutes: 7 * 60, opEndMinutes: 24 * 60 + 30 };
    const starts = generateSlotStarts(config);
    expect(starts).toContain(23 * 60 + 30); // 23:30-24:00
    expect(starts[starts.length - 1]).toBe(24 * 60); // 24:00-24:30, past midnight
  });
});

describe('parseSlotSelection', () => {
  it('accepts a contiguous aligned selection and reports its duration', () => {
    const result = parseSlotSelection(['18:30', '18:00', '19:00'], CONFIG);
    expect(result.startMinutes).toEqual([18 * 60, 18 * 60 + 30, 19 * 60]);
    expect(result.durationMinutes).toBe(90);
  });

  it('rejects an empty selection', () => {
    expect(() => parseSlotSelection([], CONFIG)).toThrow(InvalidSlotSelectionError);
  });

  it('rejects duplicates', () => {
    expect(() => parseSlotSelection(['18:00', '18:00'], CONFIG)).toThrow(InvalidSlotSelectionError);
  });

  it('rejects gaps', () => {
    expect(() => parseSlotSelection(['18:00', '19:00'], CONFIG)).toThrow(/contiguous/);
  });

  it('rejects off-grid times', () => {
    expect(() => parseSlotSelection(['18:15'], CONFIG)).toThrow(/grid/);
  });

  it('rejects slots outside operating hours', () => {
    expect(() => parseSlotSelection(['06:30'], CONFIG)).toThrow(OutsideOperatingHoursError);
    expect(() => parseSlotSelection(['21:30', '22:00'], CONFIG)).toThrow(OutsideOperatingHoursError);
  });

  it('accepts past-midnight labels when hours allow them', () => {
    const config: SlotGridConfig = { slotDurationMinutes: 30, opStartMinutes: 7 * 60, opEndMinutes: 24 * 60 + 30 };
    const result = parseSlotSelection(['23:30', '24:00'], config);
    expect(result.startMinutes).toEqual([1410, 1440]);
    expect(result.durationMinutes).toBe(60);
  });
});

describe('selectionToRange', () => {
  it('spans from the first slot start to the last slot end', () => {
    const range = selectionToRange('2026-07-01', [18 * 60, 18 * 60 + 30], CONFIG, NY);
    expect(range.startsAt.toISOString()).toBe('2026-07-01T22:00:00.000Z');
    expect(range.endsAt.toISOString()).toBe('2026-07-01T23:00:00.000Z');
  });

  it('crosses midnight into the next UTC/local day', () => {
    const config: SlotGridConfig = { slotDurationMinutes: 30, opStartMinutes: 7 * 60, opEndMinutes: 24 * 60 + 30 };
    const range = selectionToRange('2026-07-01', [1410, 1440], config, NY);
    expect(range.startsAt.toISOString()).toBe('2026-07-02T03:30:00.000Z'); // 23:30 local
    expect(range.endsAt.toISOString()).toBe('2026-07-02T04:30:00.000Z'); // 00:30 next local day
  });
});

describe('availability', () => {
  const DATE = '2026-07-01';

  it('excludes claimed slots per resource', () => {
    const free = freeSlotStartsByResource({
      dateKey: DATE,
      config: CONFIG,
      resourceIds: ['r1', 'r2'],
      claims: [claim('r1', DATE, 18 * 60, 19 * 60)],
      timeZone: NY,
    });

    expect(free.get('r1')).not.toContain(18 * 60);
    expect(free.get('r1')).not.toContain(18 * 60 + 30);
    expect(free.get('r1')).toContain(19 * 60);
    expect(free.get('r2')).toContain(18 * 60);
  });

  it('treats a partial overlap as claimed', () => {
    // A claim covering 18:15-18:45 blocks both the 18:00 and 18:30 slots.
    const free = freeSlotStartsByResource({
      dateKey: DATE,
      config: CONFIG,
      resourceIds: ['r1'],
      claims: [claim('r1', DATE, 18 * 60 + 15, 18 * 60 + 45)],
      timeZone: NY,
    });
    expect(free.get('r1')).not.toContain(18 * 60);
    expect(free.get('r1')).not.toContain(18 * 60 + 30);
  });

  it('drops slots at or before notBefore (today)', () => {
    const now = wallTimeToUtc(DATE, 18 * 60, NY);
    const free = freeSlotStartsByResource({
      dateKey: DATE,
      config: CONFIG,
      resourceIds: ['r1'],
      claims: [],
      timeZone: NY,
      notBefore: now,
    });
    expect(free.get('r1')).not.toContain(18 * 60);
    expect(free.get('r1')).toContain(18 * 60 + 30);
  });

  it('unions across resources for the picker', () => {
    const free = freeSlotStartsByResource({
      dateKey: DATE,
      config: CONFIG,
      resourceIds: ['r1', 'r2'],
      claims: [claim('r1', DATE, 18 * 60, 19 * 60), claim('r2', DATE, 19 * 60, 20 * 60)],
      timeZone: NY,
    });
    const union = unionSlotStarts(free);
    // Every slot is free somewhere, so the union shows all of them.
    expect(union).toContain(18 * 60);
    expect(union).toContain(19 * 60);
  });

  it('per-resource fragmentation: the union shows a range no single resource can host', () => {
    // r1 is busy 18:00-19:00, r2 is busy 19:00-20:00. The union shows
    // 18:00-20:00 fully free, but no single resource can host all four slots.
    const free = freeSlotStartsByResource({
      dateKey: DATE,
      config: CONFIG,
      resourceIds: ['r1', 'r2'],
      claims: [claim('r1', DATE, 18 * 60, 19 * 60), claim('r2', DATE, 19 * 60, 20 * 60)],
      timeZone: NY,
    });
    const selection = [18 * 60, 18 * 60 + 30, 19 * 60, 19 * 60 + 30];

    const union = new Set(unionSlotStarts(free));
    for (const start of selection) expect(union.has(start)).toBe(true);

    expect(resourcesFreeForSelection(free, selection, ['r1', 'r2'])).toEqual([]);
  });

  it('returns hosting candidates in resource order', () => {
    const free = freeSlotStartsByResource({
      dateKey: DATE,
      config: CONFIG,
      resourceIds: ['r1', 'r2', 'r3'],
      claims: [claim('r2', DATE, 18 * 60, 19 * 60)],
      timeZone: NY,
    });
    expect(resourcesFreeForSelection(free, [18 * 60, 18 * 60 + 30], ['r1', 'r2', 'r3'])).toEqual(['r1', 'r3']);
  });
});

describe('computeTotalCents', () => {
  it('prices whole and fractional hours in integer cents', () => {
    expect(computeTotalCents(2000, 60)).toBe(2000);
    expect(computeTotalCents(2000, 90)).toBe(3000);
    expect(computeTotalCents(2000, 30)).toBe(1000);
  });

  it('rounds odd-rate half-slots deterministically', () => {
    expect(computeTotalCents(1525, 30)).toBe(763); // 762.5 rounds half-up
  });
});
