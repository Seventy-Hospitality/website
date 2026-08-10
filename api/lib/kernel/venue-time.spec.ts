import {
  addDaysToDateKey,
  getZonedParts,
  minutesToTimeLabel,
  timeLabelToMinutes,
  wallTimeToUtc,
  zonedDateKey,
  zonedMinutesSinceMidnight,
} from './venue-time';

const NY = 'America/New_York';

describe('venue-time', () => {
  describe('wallTimeToUtc', () => {
    it('converts a venue wall time to the right instant (EDT)', () => {
      // 18:00 New York on 2026-07-01 is 22:00 UTC (UTC-4)
      expect(wallTimeToUtc('2026-07-01', 18 * 60, NY).toISOString()).toBe('2026-07-01T22:00:00.000Z');
    });

    it('converts a venue wall time to the right instant (EST)', () => {
      // 18:00 New York on 2026-01-15 is 23:00 UTC (UTC-5)
      expect(wallTimeToUtc('2026-01-15', 18 * 60, NY).toISOString()).toBe('2026-01-15T23:00:00.000Z');
    });

    it('rolls minutes past 1440 into the next local day', () => {
      // Minute 1470 of 2026-07-01 = 00:30 on 2026-07-02 local = 04:30 UTC
      expect(wallTimeToUtc('2026-07-01', 1470, NY).toISOString()).toBe('2026-07-02T04:30:00.000Z');
    });

    it('keeps the wall time fixed across the spring-forward transition', () => {
      // 19:00 stays 19:00 local on both sides of the 2026-03-08 DST jump.
      const before = wallTimeToUtc('2026-03-07', 19 * 60, NY);
      const after = wallTimeToUtc('2026-03-08', 19 * 60, NY);
      expect(getZonedParts(before, NY).hour).toBe(19);
      expect(getZonedParts(after, NY).hour).toBe(19);
      // Offsets differ: the real gap is 23h, not 24h.
      expect(after.getTime() - before.getTime()).toBe(23 * 60 * 60 * 1000);
    });

    it('resolves a nonexistent wall time deterministically', () => {
      // 02:30 on 2026-03-08 does not exist in New York (02:00 -> 03:00).
      const a = wallTimeToUtc('2026-03-08', 150, NY);
      const b = wallTimeToUtc('2026-03-08', 150, NY);
      expect(a.getTime()).toBe(b.getTime());
      // It lands inside the surrounding hour, never a day off.
      expect(zonedDateKey(a, NY)).toBe('2026-03-08');
    });

    it('resolves an ambiguous fall-back wall time deterministically', () => {
      // 01:30 on 2026-11-01 happens twice in New York.
      const a = wallTimeToUtc('2026-11-01', 90, NY);
      const b = wallTimeToUtc('2026-11-01', 90, NY);
      expect(a.getTime()).toBe(b.getTime());
      const parts = getZonedParts(a, NY);
      expect(parts.hour).toBe(1);
      expect(parts.minute).toBe(30);
    });
  });

  describe('zonedDateKey', () => {
    it('reports the venue-local date of an instant', () => {
      // 03:00 UTC is 23:00 the previous day in New York (EDT)
      expect(zonedDateKey(new Date('2026-07-02T03:00:00.000Z'), NY)).toBe('2026-07-01');
    });
  });

  describe('zonedMinutesSinceMidnight', () => {
    it('is the plain wall offset within the anchor date', () => {
      const instant = wallTimeToUtc('2026-07-01', 19 * 60 + 30, NY);
      expect(zonedMinutesSinceMidnight(instant, NY, '2026-07-01')).toBe(19 * 60 + 30);
    });

    it('exceeds 1440 for the day after the anchor', () => {
      const instant = wallTimeToUtc('2026-07-01', 1470, NY);
      expect(zonedMinutesSinceMidnight(instant, NY, '2026-07-01')).toBe(1470);
    });
  });

  describe('labels and date keys', () => {
    it('round-trips labels, including hours past 24', () => {
      expect(minutesToTimeLabel(1470)).toBe('24:30');
      expect(timeLabelToMinutes('24:30')).toBe(1470);
      expect(minutesToTimeLabel(19 * 60)).toBe('19:00');
      expect(timeLabelToMinutes('07:30')).toBe(450);
    });

    it('adds days across month boundaries', () => {
      expect(addDaysToDateKey('2026-08-30', 3)).toBe('2026-09-02');
    });
  });
});
