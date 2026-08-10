export type MemberTier = 'member' | 'pro';

/**
 * A resource type carries ALL facility policy: slot grid, operating hours as
 * minutes from venue-local midnight (end may exceed 1440 for past-midnight
 * hours), rate, horizon, per-member daily limit and tier gate. Resources are
 * the physical units; per-resource `active` covers maintenance downtime and
 * deliberately nothing else, so type-aggregated availability stays sound.
 */
export interface ResourceType {
  id: string;
  code: string; // badminton_court | tennis_court | mahjong_table | tennis_simulator | shower
  name: string;
  slotDurationMinutes: number;
  opStartMinutes: number;
  opEndMinutes: number;
  hourlyRateCents: number;
  maxAdvanceDays: number;
  maxReservationsPerMemberPerDay: number;
  cancellationDeadlineMinutes: number;
  minTier: MemberTier;
  active: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Resource {
  id: string;
  typeId: string;
  name: string;
  active: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** PRO gating is data, not an auth policy: enforce where reservations happen. */
export function tierSatisfies(memberTier: MemberTier | null | undefined, minTier: MemberTier): boolean {
  if (minTier === 'member') return true;
  return memberTier === 'pro';
}
