import type { MemberSearchResult } from '../../../lib/api';
import {
  addInviteClub,
  clubChipLabel,
  EMPTY_INVITE_SELECTION,
  inviteCount,
  inviteesPayload,
  isClubSelected,
  memberDisplayName,
  memberNumberLabel,
  removeInviteClub,
  toggleInviteMember,
  type InviteClub,
} from '../invites';

const bob: MemberSearchResult = {
  id: 'm1',
  memberNumber: 'A96486',
  firstName: 'Bob',
  lastName: 'Park',
  displayName: null,
  avatarUrl: null,
};

const club: InviteClub = { id: 'c1', name: 'Baddies', memberCount: 6 };

describe('invite selection', () => {
  it('toggles a member on and off', () => {
    const added = toggleInviteMember(EMPTY_INVITE_SELECTION, bob);
    expect(added.members).toHaveLength(1);
    const removed = toggleInviteMember(added, bob);
    expect(removed.members).toHaveLength(0);
  });

  it('adds a club once and removes it', () => {
    const added = addInviteClub(EMPTY_INVITE_SELECTION, club);
    expect(isClubSelected(added, club.id)).toBe(true);
    // A second add is a no-op.
    expect(addInviteClub(added, club).clubs).toHaveLength(1);
    expect(removeInviteClub(added, club.id).clubs).toHaveLength(0);
  });

  it('counts members and clubs together', () => {
    const sel = addInviteClub(toggleInviteMember(EMPTY_INVITE_SELECTION, bob), club);
    expect(inviteCount(sel)).toBe(2);
  });

  it('builds the create payload, omitting empty sides and the whole thing when empty', () => {
    expect(inviteesPayload(EMPTY_INVITE_SELECTION)).toBeUndefined();
    const membersOnly = toggleInviteMember(EMPTY_INVITE_SELECTION, bob);
    expect(inviteesPayload(membersOnly)).toEqual({ memberIds: ['m1'] });
    const both = addInviteClub(membersOnly, club);
    expect(inviteesPayload(both)).toEqual({ memberIds: ['m1'], clubIds: ['c1'] });
  });

  it('labels chips and rows per the Figma', () => {
    expect(clubChipLabel(club)).toBe('CLUB: Baddies (6)');
    expect(memberDisplayName(bob)).toBe('Bob Park');
    expect(memberDisplayName({ ...bob, displayName: 'Bobby' })).toBe('Bobby');
    expect(memberNumberLabel('A96486')).toBe('#A96486');
  });
});
