import {
  applyInvitationResponse,
  applyRoleChange,
  assertCanLeave,
  assertRemovable,
  canPerform,
  clubInvariants,
  pickSuccessor,
  type ClubAction,
  type ClubMembershipView,
} from './club';
import {
  CannotRemoveClubOwnerError,
  ClubMustHaveOwnerError,
  ClubPermissionError,
  ClubValidationError,
  InvalidInvitationStateError,
  OwnerMustTransferFirstError,
} from './errors';

function member(memberId: string, role: 'owner' | 'member', joinedAt = new Date('2026-01-01T00:00:00Z')): ClubMembershipView {
  return { memberId, role, joinedAt };
}

describe('canPerform (who-can-do-what matrix)', () => {
  const ownerOnly: ClubAction[] = ['edit', 'delete', 'removeMember', 'changeRole', 'rotateInviteLink'];
  const memberAllowed: ClubAction[] = ['view', 'invite', 'createInviteLink', 'leave'];

  it('grants the owner everything', () => {
    for (const action of [...ownerOnly, ...memberAllowed]) {
      expect(canPerform('owner', action)).toBe(true);
    }
  });

  it('grants members view, invite, invite links and leave (the Figma invite modal is open to members)', () => {
    for (const action of memberAllowed) {
      expect(canPerform('member', action)).toBe(true);
    }
  });

  it('denies members every owner-only action', () => {
    for (const action of ownerOnly) {
      expect(canPerform('member', action)).toBe(false);
    }
  });

  it('denies non-members everything', () => {
    for (const action of [...ownerOnly, ...memberAllowed]) {
      expect(canPerform(null, action)).toBe(false);
      expect(canPerform(undefined, action)).toBe(false);
    }
  });
});

describe('assertCanLeave (owner must transfer first)', () => {
  it('lets a plain member leave', () => {
    expect(() => assertCanLeave('member')).not.toThrow();
  });

  it('blocks the owner until ownership is transferred', () => {
    expect(() => assertCanLeave('owner')).toThrow(OwnerMustTransferFirstError);
  });
});

describe('assertRemovable', () => {
  it('lets the owner remove a plain member', () => {
    expect(() => assertRemovable(member('m1', 'owner'), member('m2', 'member'))).not.toThrow();
  });

  it('rejects a non-owner actor', () => {
    expect(() => assertRemovable(member('m1', 'member'), member('m2', 'member'))).toThrow(
      ClubPermissionError,
    );
  });

  it('never removes the owner (self or role)', () => {
    expect(() => assertRemovable(member('m1', 'owner'), member('m1', 'owner'))).toThrow(
      CannotRemoveClubOwnerError,
    );
    expect(() => assertRemovable(member('m1', 'owner'), member('m2', 'owner'))).toThrow(
      CannotRemoveClubOwnerError,
    );
  });
});

describe('applyRoleChange (single-owner model)', () => {
  it('transfer: promoting another member demotes the acting owner in the same diff', () => {
    const changes = applyRoleChange(member('m1', 'owner'), member('m2', 'member'), 'owner');
    expect(changes).toEqual([
      { memberId: 'm2', role: 'owner' },
      { memberId: 'm1', role: 'member' },
    ]);
  });

  it('promoting yourself while already owner is a no-op', () => {
    expect(applyRoleChange(member('m1', 'owner'), member('m1', 'owner'), 'owner')).toEqual([]);
  });

  it('demoting yourself is rejected: the club would have no owner', () => {
    expect(() => applyRoleChange(member('m1', 'owner'), member('m1', 'owner'), 'member')).toThrow(
      ClubMustHaveOwnerError,
    );
  });

  it('demoting a plain member to member is a no-op', () => {
    expect(applyRoleChange(member('m1', 'owner'), member('m2', 'member'), 'member')).toEqual([]);
  });

  it('rejects a non-owner actor', () => {
    expect(() => applyRoleChange(member('m1', 'member'), member('m2', 'member'), 'owner')).toThrow(
      ClubPermissionError,
    );
  });
});

describe('pickSuccessor (account-deletion transfer)', () => {
  it('picks the longest-tenured remaining member', () => {
    const successor = pickSuccessor([
      member('m3', 'member', new Date('2026-03-01T00:00:00Z')),
      member('m2', 'member', new Date('2026-02-01T00:00:00Z')),
    ]);
    expect(successor?.memberId).toBe('m2');
  });

  it('breaks tenure ties on member id for determinism', () => {
    const when = new Date('2026-02-01T00:00:00Z');
    const successor = pickSuccessor([member('mb', 'member', when), member('ma', 'member', when)]);
    expect(successor?.memberId).toBe('ma');
  });

  it('returns null when nobody remains (the club is deleted instead)', () => {
    expect(pickSuccessor([])).toBeNull();
  });
});

describe('applyInvitationResponse (acceptance state machine, OPEN decision 4)', () => {
  it('pending + accept -> accepted', () => {
    expect(applyInvitationResponse('pending', 'accept')).toBe('accepted');
  });

  it('pending + decline -> declined', () => {
    expect(applyInvitationResponse('pending', 'decline')).toBe('declined');
  });

  it('repeat responses are idempotent', () => {
    expect(applyInvitationResponse('accepted', 'accept')).toBe('accepted');
    expect(applyInvitationResponse('declined', 'decline')).toBe('declined');
  });

  it('accepted + decline is invalid: leave the club instead', () => {
    expect(() => applyInvitationResponse('accepted', 'decline')).toThrow(
      InvalidInvitationStateError,
    );
  });

  it('declined + accept needs a fresh invite', () => {
    expect(() => applyInvitationResponse('declined', 'accept')).toThrow(
      InvalidInvitationStateError,
    );
  });

  it('a revoked invitation answers nothing', () => {
    expect(() => applyInvitationResponse('revoked', 'accept')).toThrow(InvalidInvitationStateError);
    expect(() => applyInvitationResponse('revoked', 'decline')).toThrow(InvalidInvitationStateError);
  });
});

describe('clubInvariants', () => {
  it('requires a non-blank name within 80 characters', () => {
    expect(() => clubInvariants.validateName('baddies')).not.toThrow();
    expect(() => clubInvariants.validateName('   ')).toThrow(ClubValidationError);
    expect(() => clubInvariants.validateName('x'.repeat(81))).toThrow(ClubValidationError);
  });

  it('caps the description at 500 characters and allows absence', () => {
    expect(() => clubInvariants.validateDescription(undefined)).not.toThrow();
    expect(() => clubInvariants.validateDescription(null)).not.toThrow();
    expect(() => clubInvariants.validateDescription('x'.repeat(500))).not.toThrow();
    expect(() => clubInvariants.validateDescription('x'.repeat(501))).toThrow(ClubValidationError);
  });
});
