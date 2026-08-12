import { listSeriesOccurrenceDates, weekdayOfDateKey } from './series';

const TZ = 'America/New_York';

describe('weekdayOfDateKey', () => {
  it('returns the calendar weekday of the local date', () => {
    expect(weekdayOfDateKey('2026-09-01')).toBe(2); // Tuesday
    expect(weekdayOfDateKey('2026-09-06')).toBe(0); // Sunday
    expect(weekdayOfDateKey('2026-09-05')).toBe(6); // Saturday
  });
});

describe('listSeriesOccurrenceDates', () => {
  // Tue 2026-09-01, 12:00 New York (16:00Z)
  const NOW = new Date('2026-09-01T16:00:00.000Z');

  it('lists the weekday matches from today through the horizon', () => {
    const dates = listSeriesOccurrenceDates({
      weekday: 4, // Thursday
      startMinutes: 18 * 60,
      horizonDays: 14,
      timeZone: TZ,
      now: NOW,
    });
    expect(dates).toEqual(['2026-09-03', '2026-09-10']);
  });

  it("includes today's occurrence only while its start is still ahead", () => {
    const base = { weekday: 2, horizonDays: 7, timeZone: TZ, now: NOW } as const; // Tuesday
    // 18:00 local is still ahead of 12:00 local.
    expect(listSeriesOccurrenceDates({ ...base, startMinutes: 18 * 60 })).toEqual([
      '2026-09-01',
      '2026-09-08',
    ]);
    // 10:00 local already passed.
    expect(listSeriesOccurrenceDates({ ...base, startMinutes: 10 * 60 })).toEqual(['2026-09-08']);
  });

  it('never reaches past the horizon a member could book', () => {
    const dates = listSeriesOccurrenceDates({
      weekday: 2,
      startMinutes: 18 * 60,
      horizonDays: 6, // next Tuesday is day 7: out
      timeZone: TZ,
      now: NOW,
    });
    expect(dates).toEqual(['2026-09-01']);
  });

  it('spans a DST transition without shifting the wall time date', () => {
    // US fall-back: Sun 2026-11-01. Now = Fri 2026-10-30, 08:00 New York.
    const dates = listSeriesOccurrenceDates({
      weekday: 1, // Monday
      startMinutes: 19 * 60,
      horizonDays: 7,
      timeZone: TZ,
      now: new Date('2026-10-30T12:00:00.000Z'),
    });
    expect(dates).toEqual(['2026-11-02']);
  });
});
