import { deriveQuickBookPattern, type BookingHistoryEntry } from './quick-book';
import { canonicalTimeZone, isValidTimeZone, timeOfDayFor } from './greeting';

// History entries are most-recent-first, matching the bookings read.
function entry(overrides: Partial<BookingHistoryEntry> = {}): BookingHistoryEntry {
  return {
    typeCode: 'badminton_court',
    localDate: '2026-08-06', // a Thursday
    startMinutes: 18 * 60,
    durationMinutes: 60,
    ...overrides,
  };
}

describe('deriveQuickBookPattern', () => {
  it('returns null without history (fallback territory)', () => {
    expect(deriveQuickBookPattern([])).toBeNull();
  });

  it('picks the most frequent type, weekday, start time and duration', () => {
    const pattern = deriveQuickBookPattern([
      entry({ localDate: '2026-08-06', startMinutes: 18 * 60 }), // Thu 18:00
      entry({ localDate: '2026-08-04', startMinutes: 19 * 60 }), // Tue
      entry({ localDate: '2026-07-30', startMinutes: 18 * 60 }), // Thu 18:00
      entry({ typeCode: 'tennis_court', localDate: '2026-07-29', startMinutes: 9 * 60 }),
      entry({ localDate: '2026-07-23', startMinutes: 20 * 60 }), // Thu 20:00
    ]);

    expect(pattern).toEqual({
      typeCode: 'badminton_court',
      weekday: 4, // Thursday
      startMinutes: 18 * 60,
      durationMinutes: 60,
    });
  });

  it('is deterministic and breaks every tie toward the most recent booking', () => {
    const history = [
      entry({ typeCode: 'tennis_court', localDate: '2026-08-05', startMinutes: 9 * 60, durationMinutes: 90 }),
      entry({ typeCode: 'badminton_court', localDate: '2026-08-04', startMinutes: 18 * 60 }),
    ];

    // 1-1 on type: tennis is more recent.
    const pattern = deriveQuickBookPattern(history);
    expect(pattern).toEqual({
      typeCode: 'tennis_court',
      weekday: 3, // Wednesday
      startMinutes: 9 * 60,
      durationMinutes: 90,
    });
    // Same input, same answer.
    expect(deriveQuickBookPattern(history)).toEqual(pattern);
  });

  it('scopes weekday/time/duration frequencies to the winning type', () => {
    const pattern = deriveQuickBookPattern([
      entry({ localDate: '2026-08-06', startMinutes: 18 * 60, durationMinutes: 60 }), // Thu
      entry({ localDate: '2026-07-30', startMinutes: 18 * 60, durationMinutes: 60 }), // Thu
      // A pile of tennis mornings that must not bleed into the badminton habit.
      entry({ typeCode: 'tennis_court', localDate: '2026-08-03', startMinutes: 8 * 60, durationMinutes: 30 }),
      entry({ typeCode: 'tennis_court', localDate: '2026-07-27', startMinutes: 8 * 60, durationMinutes: 30 }),
    ]);

    expect(pattern).toMatchObject({ typeCode: 'badminton_court', startMinutes: 18 * 60, durationMinutes: 60 });
  });
});

describe('greeting helpers', () => {
  it('maps the viewer wall clock to morning/afternoon/evening', () => {
    const instant = new Date('2026-09-01T15:00:00.000Z');
    expect(timeOfDayFor(instant, 'America/New_York')).toBe('morning'); // 11:00
    expect(timeOfDayFor(instant, 'Europe/London')).toBe('afternoon'); // 16:00
    expect(timeOfDayFor(instant, 'Asia/Hong_Kong')).toBe('evening'); // 23:00
  });

  it('validates client-supplied IANA zones', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });

  it('canonicalizes every accepted spelling to ONE zone name (cache-key safety)', () => {
    // Intl matches zones case-insensitively; the raw client string must
    // never key a cache, or its case-permutations grow it without bound.
    expect(canonicalTimeZone('America/New_York')).toBe('America/New_York');
    expect(canonicalTimeZone('aMeRiCa/nEw_yOrK')).toBe('America/New_York');
    expect(canonicalTimeZone('AMERICA/NEW_YORK')).toBe('America/New_York');
    expect(canonicalTimeZone('Not/AZone')).toBeNull();
    expect(canonicalTimeZone('')).toBeNull();
    expect(canonicalTimeZone(undefined)).toBeNull();
    expect(canonicalTimeZone(42)).toBeNull();
    expect(canonicalTimeZone(`America/${'x'.repeat(80)}`)).toBeNull(); // length-capped before Intl
  });
});
