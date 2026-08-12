import { activityFamilyForTypeCode, aggregateActivityStats } from './activity-stats';

describe('activityFamilyForTypeCode', () => {
  it('maps only real courts to a family', () => {
    expect(activityFamilyForTypeCode('badminton_court')).toBe('badminton');
    expect(activityFamilyForTypeCode('tennis_court')).toBe('tennis');
  });

  it('excludes simulators, mahjong tables and showers', () => {
    expect(activityFamilyForTypeCode('tennis_simulator')).toBeNull();
    expect(activityFamilyForTypeCode('mahjong_table')).toBeNull();
    expect(activityFamilyForTypeCode('shower')).toBeNull();
    expect(activityFamilyForTypeCode('unknown_thing')).toBeNull();
  });
});

describe('aggregateActivityStats', () => {
  it('counts court bookings and sums minutes per family', () => {
    const stats = aggregateActivityStats([
      { typeCode: 'badminton_court', count: 12, minutes: 12 * 60 },
      { typeCode: 'tennis_court', count: 3, minutes: 270 },
      { typeCode: 'tennis_simulator', count: 5, minutes: 300 },
      { typeCode: 'mahjong_table', count: 9, minutes: 999 },
    ]);

    expect(stats).toEqual({
      courtsBooked: 15, // 12 badminton + 3 tennis; simulator/mahjong excluded
      badmintonMinutes: 720,
      tennisMinutes: 270, // half-hour granularity survives (4.5 hours)
    });
  });

  it('is all zeroes for a member with no confirmed court reservations', () => {
    expect(aggregateActivityStats([])).toEqual({
      courtsBooked: 0,
      badmintonMinutes: 0,
      tennisMinutes: 0,
    });
  });
});
