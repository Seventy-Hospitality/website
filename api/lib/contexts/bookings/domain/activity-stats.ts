// ── Lifetime activity stats (the account screen's three numbers) ──
// Definition (decided in docs/decisions-account.md): the member's CONFIRMED
// reservations as ORGANIZER, lifetime (no window; future confirmed bookings
// count — "booked", not "played"). Hours are the sum of scheduled
// reservation durations (endsAt - startsAt) per court family; DST does not
// bend them because durations are instant differences. Only real courts
// participate: badminton_court -> badminton, tennis_court -> tennis;
// simulators, mahjong tables and showers belong to no family and are
// excluded from both the counts and the hours.

export type ActivityFamily = 'badminton' | 'tennis';

export interface ActivityStats {
  courtsBooked: number;
  badmintonMinutes: number;
  tennisMinutes: number;
}

export function activityFamilyForTypeCode(code: string): ActivityFamily | null {
  if (code === 'badminton_court') return 'badminton';
  if (code === 'tennis_court') return 'tennis';
  return null;
}

export interface ActivityStatRow {
  typeCode: string;
  count: number;
  minutes: number;
}

export function aggregateActivityStats(rows: ActivityStatRow[]): ActivityStats {
  const stats: ActivityStats = { courtsBooked: 0, badmintonMinutes: 0, tennisMinutes: 0 };
  for (const row of rows) {
    const family = activityFamilyForTypeCode(row.typeCode);
    if (!family) continue;
    stats.courtsBooked += row.count;
    if (family === 'badminton') stats.badmintonMinutes += row.minutes;
    else stats.tennisMinutes += row.minutes;
  }
  return stats;
}
