/**
 * Pure invite-selection logic for the booking wizard's "Invite players"
 * step (package W3): individually picked members plus club chips that the
 * backend expands to the club's current roster at reservation create.
 */
import type { MemberSearchResult, ReservationInvitees } from './api';

/** The club fields the chip needs (satisfied by ClubSummary / MyClub). */
export interface InviteClub {
  id: string;
  name: string;
  memberCount: number;
}

export interface InviteSelection {
  /** Individually picked members, in pick order (chips render this order). */
  members: MemberSearchResult[];
  /** Club chips, in pick order. */
  clubs: InviteClub[];
}

export const EMPTY_INVITE_SELECTION: InviteSelection = { members: [], clubs: [] };

export function isMemberSelected(selection: InviteSelection, memberId: string): boolean {
  return selection.members.some((member) => member.id === memberId);
}

export function isClubSelected(selection: InviteSelection, clubId: string): boolean {
  return selection.clubs.some((club) => club.id === clubId);
}

/** Adds the member, or removes them when already selected. */
export function toggleInviteMember(
  selection: InviteSelection,
  member: MemberSearchResult,
): InviteSelection {
  if (isMemberSelected(selection, member.id)) {
    return removeInviteMember(selection, member.id);
  }
  return { ...selection, members: [...selection.members, member] };
}

export function removeInviteMember(
  selection: InviteSelection,
  memberId: string,
): InviteSelection {
  return {
    ...selection,
    members: selection.members.filter((member) => member.id !== memberId),
  };
}

/** "Add all" on a club row; a second add of the same club is a no-op. */
export function addInviteClub(selection: InviteSelection, club: InviteClub): InviteSelection {
  if (isClubSelected(selection, club.id)) return selection;
  return { ...selection, clubs: [...selection.clubs, club] };
}

export function removeInviteClub(selection: InviteSelection, clubId: string): InviteSelection {
  return { ...selection, clubs: selection.clubs.filter((club) => club.id !== clubId) };
}

export function inviteCount(selection: InviteSelection): number {
  return selection.members.length + selection.clubs.length;
}

/**
 * The create/addParticipants payload. Undefined when nothing is selected
 * so the request body omits `invitees` entirely.
 */
export function inviteesPayload(selection: InviteSelection): ReservationInvitees | undefined {
  const memberIds = selection.members.map((member) => member.id);
  const clubIds = selection.clubs.map((club) => club.id);
  if (memberIds.length === 0 && clubIds.length === 0) return undefined;
  return {
    ...(memberIds.length > 0 ? { memberIds } : {}),
    ...(clubIds.length > 0 ? { clubIds } : {}),
  };
}

/** Chip label per the Figma: "CLUB: baddies (6)". */
export function clubChipLabel(club: InviteClub): string {
  return `CLUB: ${club.name} (${club.memberCount})`;
}

/** Presentation name: the chosen displayName, else "First Last". */
export function memberDisplayName(member: {
  firstName: string;
  lastName: string;
  displayName?: string | null;
}): string {
  return member.displayName?.trim() || `${member.firstName} ${member.lastName}`.trim();
}

/** "#A12345" for the row subtitle. */
export function memberNumberLabel(memberNumber: string): string {
  return `#${memberNumber}`;
}
