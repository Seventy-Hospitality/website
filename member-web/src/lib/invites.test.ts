import { describe, expect, it } from 'vitest';
import type { MemberSearchResult } from './api';
import {
  EMPTY_INVITE_SELECTION,
  addInviteClub,
  clubChipLabel,
  inviteCount,
  inviteesPayload,
  memberDisplayName,
  removeInviteClub,
  removeInviteMember,
  toggleInviteMember,
} from './invites';

function member(id: string, overrides: Partial<MemberSearchResult> = {}): MemberSearchResult {
  return {
    id,
    memberNumber: 'A12345',
    firstName: 'Wesley',
    lastName: 'Wang',
    displayName: null,
    avatarUrl: null,
    ...overrides,
  };
}

const BADDIES = { id: 'club1', name: 'baddies', memberCount: 6 };

describe('invite selection', () => {
  it('toggles members on and off, preserving pick order', () => {
    let selection = toggleInviteMember(EMPTY_INVITE_SELECTION, member('m1'));
    selection = toggleInviteMember(selection, member('m2'));
    expect(selection.members.map((entry) => entry.id)).toEqual(['m1', 'm2']);

    selection = toggleInviteMember(selection, member('m1'));
    expect(selection.members.map((entry) => entry.id)).toEqual(['m2']);
  });

  it('removes members by id', () => {
    const selection = toggleInviteMember(EMPTY_INVITE_SELECTION, member('m1'));
    expect(removeInviteMember(selection, 'm1').members).toEqual([]);
  });

  it('adds a club once; a repeat add is a no-op', () => {
    const once = addInviteClub(EMPTY_INVITE_SELECTION, BADDIES);
    const twice = addInviteClub(once, BADDIES);
    expect(twice.clubs).toHaveLength(1);
    expect(removeInviteClub(twice, 'club1').clubs).toEqual([]);
  });

  it('counts chips across members and clubs', () => {
    let selection = addInviteClub(EMPTY_INVITE_SELECTION, BADDIES);
    selection = toggleInviteMember(selection, member('m1'));
    expect(inviteCount(selection)).toBe(2);
  });

  it('builds the invitees payload and omits empty groups', () => {
    expect(inviteesPayload(EMPTY_INVITE_SELECTION)).toBeUndefined();

    const membersOnly = toggleInviteMember(EMPTY_INVITE_SELECTION, member('m1'));
    expect(inviteesPayload(membersOnly)).toEqual({ memberIds: ['m1'] });

    const both = addInviteClub(membersOnly, BADDIES);
    expect(inviteesPayload(both)).toEqual({ memberIds: ['m1'], clubIds: ['club1'] });
  });

  it('labels club chips per the Figma', () => {
    expect(clubChipLabel(BADDIES)).toBe('CLUB: baddies (6)');
  });

  it('prefers the chosen display name and falls back to first + last', () => {
    expect(memberDisplayName(member('m1'))).toBe('Wesley Wang');
    expect(memberDisplayName(member('m1', { displayName: 'Wes' }))).toBe('Wes');
  });
});
