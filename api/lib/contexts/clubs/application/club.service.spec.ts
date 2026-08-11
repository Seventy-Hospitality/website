import { ClubService } from './club.service';
import type { AuditLog, ManagedCoverImageStore } from './ports';
import {
  CannotRemoveClubOwnerError,
  ClubInvitationNotFoundError,
  ClubInviteeNotFoundError,
  ClubMemberNotFoundError,
  ClubNotFoundError,
  ClubPermissionError,
  InvalidInvitationStateError,
  InviteLinkInvalidError,
  OwnerMustTransferFirstError,
} from '../domain';
import type { ClubRepository } from '../infrastructure/club.repository';
import type { UnitOfWork } from '@/lib/kernel';

const NOW = new Date('2026-08-10T12:00:00Z');

function clubRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clb_1',
    name: 'baddies',
    description: null,
    coverImageUrl: null,
    createdById: 'mem_owner',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function membership(memberId: string, role: 'owner' | 'member', joinedAt = NOW) {
  return { id: `cm_${memberId}`, clubId: 'clb_1', memberId, role, joinedAt };
}

function rosterRow(memberId: string, role: 'owner' | 'member', joinedAt = NOW) {
  return {
    ...membership(memberId, role, joinedAt),
    member: { id: memberId, firstName: 'First', lastName: memberId },
  };
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    clubId: 'clb_1',
    inviterId: 'mem_owner',
    inviteeMemberId: 'mem_9',
    status: 'pending',
    respondedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function linkRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cil_1',
    clubId: 'clb_1',
    tokenHash: 'hash',
    createdById: 'mem_owner',
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    maxUses: null,
    useCount: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function mockRepo(): ClubRepository {
  return {
    advisoryLockClub: vi.fn(),
    createClub: vi.fn().mockResolvedValue(clubRecord()),
    getClub: vi.fn().mockResolvedValue(clubRecord()),
    updateClub: vi.fn().mockResolvedValue(clubRecord()),
    deleteClub: vi.fn(),
    countMembers: vi.fn().mockResolvedValue(2),
    listForMember: vi.fn().mockResolvedValue([]),
    getMembership: vi.fn().mockResolvedValue(null),
    listRoster: vi.fn().mockResolvedValue([rosterRow('mem_owner', 'owner'), rosterRow('mem_2', 'member')]),
    addMember: vi.fn().mockResolvedValue(true),
    removeMember: vi.fn(),
    setMemberRole: vi.fn(),
    listMembershipsForMember: vi.fn().mockResolvedValue([]),
    createInvitation: vi.fn().mockResolvedValue(invitation()),
    getInvitation: vi.fn().mockResolvedValue(null),
    transitionInvitation: vi.fn().mockResolvedValue(true),
    listPendingForInvitee: vi.fn().mockResolvedValue([]),
    listPendingInviteeIds: vi.fn().mockResolvedValue(new Set()),
    acceptPendingInvitationFor: vi.fn(),
    withdrawPendingInvitationsBy: vi.fn().mockResolvedValue([]),
    withdrawPendingInvitationsTo: vi.fn().mockResolvedValue([]),
    revokeInviteLinksCreatedBy: vi.fn().mockResolvedValue([]),
    createInviteLink: vi.fn().mockResolvedValue(linkRecord()),
    findInviteLinkByTokenHash: vi.fn().mockResolvedValue(null),
    revokeActiveInviteLinks: vi.fn().mockResolvedValue([]),
    consumeInviteLinkUse: vi.fn().mockResolvedValue(true),
    filterExistingMemberIds: vi.fn(async (ids: string[]) => new Set(ids)),
  } as unknown as ClubRepository;
}

function mockCoverStore(): ManagedCoverImageStore {
  return {
    uploadCoverImage: vi.fn().mockResolvedValue({ publicPath: '/uploads/event-images/cover.jpg' }),
    attachManagedAssetToOwner: vi.fn(),
    deleteManagedAsset: vi.fn(),
  };
}

function mockAudit(): AuditLog {
  return { append: vi.fn().mockResolvedValue({ id: 'evt', seq: 1 }) };
}

function mockUow(): UnitOfWork {
  return { execute: vi.fn(async (fn: any) => fn({})) } as unknown as UnitOfWork;
}

function buildService(overrides: {
  repo?: ClubRepository;
  coverStore?: ManagedCoverImageStore;
  audit?: AuditLog;
  uow?: UnitOfWork;
} = {}) {
  const repo = overrides.repo ?? mockRepo();
  const coverStore = overrides.coverStore ?? mockCoverStore();
  const audit = overrides.audit ?? mockAudit();
  const uow = overrides.uow ?? mockUow();
  const service = new ClubService(repo, coverStore, audit, uow);
  return { service, repo, coverStore, audit, uow };
}

function auditEventTypes(audit: AuditLog): string[] {
  return (audit.append as ReturnType<typeof vi.fn>).mock.calls.map(([, event]) => event.eventType);
}

/** Membership answers per member id (everything else: not a member). */
function grantMemberships(repo: ClubRepository, rows: Array<ReturnType<typeof membership>>) {
  (repo.getMembership as ReturnType<typeof vi.fn>).mockImplementation(
    async (_clubId: string, memberId: string) => rows.find((row) => row.memberId === memberId) ?? null,
  );
}

describe('ClubService.create', () => {
  it('creates the club with the creator as owner and invites the batch (never the creator)', async () => {
    const { service, repo, audit } = buildService();

    const result = await service.create(
      { name: '  baddies  ', inviteeMemberIds: ['mem_2', 'mem_3', 'mem_owner', 'mem_2'] },
      { memberId: 'mem_owner', actorId: 'usr_1' },
    );

    expect(repo.createClub).toHaveBeenCalledWith(expect.anything(), {
      name: 'baddies',
      description: null,
      createdById: 'mem_owner',
    });
    expect(result.invited).toEqual(['mem_2', 'mem_3']);
    expect(result.club.memberCount).toBe(1);
    expect(auditEventTypes(audit)).toEqual([
      'club.created',
      'club.invitation_sent',
      'club.invitation_sent',
    ]);
  });

  it('rejects unknown invitees before writing anything', async () => {
    const repo = mockRepo();
    (repo.filterExistingMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Set(['mem_2']));
    const { service } = buildService({ repo });

    await expect(
      service.create({ name: 'baddies', inviteeMemberIds: ['mem_2', 'ghost'] }, { memberId: 'mem_owner' }),
    ).rejects.toThrow(ClubInviteeNotFoundError);
    expect(repo.createClub).not.toHaveBeenCalled();
  });
});

describe('ClubService.getForViewer (IDOR shape)', () => {
  it('answers 404-shaped for a non-member, identical to a missing club', async () => {
    const { service } = buildService(); // getMembership -> null
    await expect(service.getForViewer('clb_1', 'mem_outsider')).rejects.toThrow(ClubNotFoundError);

    const repo = mockRepo();
    (repo.getClub as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { service: service2 } = buildService({ repo });
    await expect(service2.getForViewer('clb_missing', 'mem_2')).rejects.toThrow(ClubNotFoundError);
  });

  it('computes permission flags from the role', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_2', 'member')]);
    const { service } = buildService({ repo });

    const detail = await service.getForViewer('clb_1', 'mem_2');
    expect(detail.permissions).toEqual({
      canEdit: false,
      canDelete: false,
      canManageMembers: false,
      canInvite: true,
      canLeave: true,
    });

    grantMemberships(repo, [membership('mem_owner', 'owner')]);
    const ownerDetail = await service.getForViewer('clb_1', 'mem_owner');
    expect(ownerDetail.permissions).toEqual({
      canEdit: true,
      canDelete: true,
      canManageMembers: true,
      canInvite: true,
      canLeave: false,
    });
  });
});

describe('ClubService.update / delete (owner-only)', () => {
  it('rejects a plain member with 403 shape and an outsider with 404 shape', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_2', 'member')]);
    const { service } = buildService({ repo });

    await expect(service.update('clb_1', { memberId: 'mem_2' }, { name: 'x' })).rejects.toThrow(
      ClubPermissionError,
    );
    await expect(service.delete('clb_1', { memberId: 'mem_2' })).rejects.toThrow(ClubPermissionError);
    await expect(service.update('clb_1', { memberId: 'mem_out' }, { name: 'x' })).rejects.toThrow(
      ClubNotFoundError,
    );
  });

  it('clearing the cover through PATCH deletes the managed asset after the write', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_owner', 'owner')]);
    (repo.getClub as ReturnType<typeof vi.fn>).mockResolvedValue(
      clubRecord({ coverImageUrl: '/uploads/event-images/old.jpg' }),
    );
    const { service, coverStore } = buildService({ repo });

    await service.update('clb_1', { memberId: 'mem_owner' }, { coverImageUrl: null });
    expect(repo.updateClub).toHaveBeenCalledWith(expect.anything(), 'clb_1', { coverImageUrl: null });
    expect(coverStore.deleteManagedAsset).toHaveBeenCalledWith('/uploads/event-images/old.jpg');
  });

  it('delete re-verifies ownership under the club lock and removes the cover asset', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_owner', 'owner')]);
    (repo.getClub as ReturnType<typeof vi.fn>).mockResolvedValue(
      clubRecord({ coverImageUrl: '/uploads/event-images/cover.jpg' }),
    );
    const { service, coverStore, audit } = buildService({ repo });

    await service.delete('clb_1', { memberId: 'mem_owner', actorId: 'usr_1' });

    expect(repo.advisoryLockClub).toHaveBeenCalled();
    expect(repo.deleteClub).toHaveBeenCalledWith(expect.anything(), 'clb_1');
    expect(coverStore.deleteManagedAsset).toHaveBeenCalledWith('/uploads/event-images/cover.jpg');
    expect(auditEventTypes(audit)).toEqual(['club.deleted']);
  });
});

describe('ClubService.setCoverImage (media happy path)', () => {
  it('uploads through the managed pipeline, points the club at it, attaches ownership and drops the old cover', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_owner', 'owner')]);
    (repo.getClub as ReturnType<typeof vi.fn>).mockResolvedValue(
      clubRecord({ coverImageUrl: '/uploads/event-images/old.jpg' }),
    );
    (repo.updateClub as ReturnType<typeof vi.fn>).mockResolvedValue(
      clubRecord({ coverImageUrl: '/uploads/event-images/cover.jpg' }),
    );
    const { service, coverStore } = buildService({ repo });

    const upload = { filename: 'cover.jpg', contentType: 'image/jpeg', bytes: Buffer.from('img') };
    const club = await service.setCoverImage('clb_1', { memberId: 'mem_owner' }, upload);

    expect(coverStore.uploadCoverImage).toHaveBeenCalledWith(upload);
    expect(repo.updateClub).toHaveBeenCalledWith(expect.anything(), 'clb_1', {
      coverImageUrl: '/uploads/event-images/cover.jpg',
    });
    expect(coverStore.attachManagedAssetToOwner).toHaveBeenCalledWith(
      '/uploads/event-images/cover.jpg',
      { ownerType: 'club', ownerId: 'clb_1' },
    );
    expect(coverStore.deleteManagedAsset).toHaveBeenCalledWith('/uploads/event-images/old.jpg');
    expect(club.coverImageUrl).toBe('/uploads/event-images/cover.jpg');
  });

  it('is owner-only', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_2', 'member')]);
    const { service, coverStore } = buildService({ repo });

    await expect(
      service.setCoverImage(
        'clb_1',
        { memberId: 'mem_2' },
        { filename: 'x.jpg', contentType: 'image/jpeg', bytes: Buffer.from('x') },
      ),
    ).rejects.toThrow(ClubPermissionError);
    expect(coverStore.uploadCoverImage).not.toHaveBeenCalled();
  });
});

describe('ClubService.leave', () => {
  it('lets a member leave and audits it', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_2', 'member')]);
    const { service, audit } = buildService({ repo });

    await service.leave('clb_1', { memberId: 'mem_2' });
    expect(repo.removeMember).toHaveBeenCalledWith(expect.anything(), 'clb_1', 'mem_2');
    expect(auditEventTypes(audit)).toEqual(['club.member_left']);
  });

  it('blocks the owner until ownership is transferred', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_owner', 'owner')]);
    const { service } = buildService({ repo });

    await expect(service.leave('clb_1', { memberId: 'mem_owner' })).rejects.toThrow(
      OwnerMustTransferFirstError,
    );
    expect(repo.removeMember).not.toHaveBeenCalled();
  });
});

describe('ClubService.changeMemberRole (transfer)', () => {
  it('transfers ownership atomically: target up, actor down, audit event', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_owner', 'owner'), membership('mem_2', 'member')]);
    const { service, audit } = buildService({ repo });

    await service.changeMemberRole('clb_1', { memberId: 'mem_owner' }, 'mem_2', 'owner');

    expect(repo.setMemberRole).toHaveBeenCalledWith(expect.anything(), 'clb_1', 'mem_2', 'owner');
    expect(repo.setMemberRole).toHaveBeenCalledWith(expect.anything(), 'clb_1', 'mem_owner', 'member');
    expect(auditEventTypes(audit)).toEqual(['club.ownership_transferred']);
  });

  it('rejects a plain member (403 shape) and a missing target (404 shape)', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_owner', 'owner'), membership('mem_2', 'member')]);
    const { service } = buildService({ repo });

    await expect(
      service.changeMemberRole('clb_1', { memberId: 'mem_2' }, 'mem_owner', 'member'),
    ).rejects.toThrow(ClubPermissionError);
    await expect(
      service.changeMemberRole('clb_1', { memberId: 'mem_owner' }, 'mem_ghost', 'owner'),
    ).rejects.toThrow(ClubMemberNotFoundError);
  });
});

describe('ClubService.removeMember', () => {
  it('owner removes a member; removing the owner is rejected', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_owner', 'owner'), membership('mem_2', 'member')]);
    const { service, audit } = buildService({ repo });

    await service.removeMember('clb_1', { memberId: 'mem_owner' }, 'mem_2');
    expect(repo.removeMember).toHaveBeenCalledWith(expect.anything(), 'clb_1', 'mem_2');
    expect(auditEventTypes(audit)).toEqual(['club.member_removed']);

    await expect(
      service.removeMember('clb_1', { memberId: 'mem_owner' }, 'mem_owner'),
    ).rejects.toThrow(CannotRemoveClubOwnerError);
  });
});

describe('ClubService.invite', () => {
  it('any club member can invite; existing members and pending invitees are silent no-ops', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_2', 'member')]);
    (repo.listPendingInviteeIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Set(['mem_5']));
    const { service, audit } = buildService({ repo });

    const result = await service.invite('clb_1', { memberId: 'mem_2' }, [
      'mem_owner', // already in the club
      'mem_5', // already pending
      'mem_6', // fresh invite
      'mem_2', // self
    ]);

    expect(result.invited).toEqual(['mem_6']);
    expect(repo.createInvitation).toHaveBeenCalledTimes(1);
    expect(repo.createInvitation).toHaveBeenCalledWith(expect.anything(), {
      clubId: 'clb_1',
      inviterId: 'mem_2',
      inviteeMemberId: 'mem_6',
    });
    expect(auditEventTypes(audit)).toEqual(['club.invitation_sent']);
  });

  it('non-members get the 404 shape', async () => {
    const { service } = buildService();
    await expect(service.invite('clb_1', { memberId: 'mem_out' }, ['mem_6'])).rejects.toThrow(
      ClubNotFoundError,
    );
  });
});

describe('ClubService.respondToInvitation (only the invitee)', () => {
  it('accept transitions the row, adds the membership and audits both', async () => {
    const repo = mockRepo();
    (repo.getInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(invitation());
    const { service, audit } = buildService({ repo });

    const result = await service.respondToInvitation('inv_1', { memberId: 'mem_9' }, 'accept');

    expect(result).toEqual({ status: 'accepted', clubId: 'clb_1' });
    expect(repo.addMember).toHaveBeenCalledWith(expect.anything(), 'clb_1', 'mem_9', 'member');
    expect(auditEventTypes(audit)).toEqual(['club.invitation_accepted', 'club.member_joined']);
  });

  it('decline keeps the history row and never adds a membership', async () => {
    const repo = mockRepo();
    (repo.getInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(invitation());
    const { service, audit } = buildService({ repo });

    const result = await service.respondToInvitation('inv_1', { memberId: 'mem_9' }, 'decline');
    expect(result.status).toBe('declined');
    expect(repo.addMember).not.toHaveBeenCalled();
    expect(auditEventTypes(audit)).toEqual(['club.invitation_declined']);
  });

  it('anyone but the invitee gets the 404 shape', async () => {
    const repo = mockRepo();
    (repo.getInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(invitation());
    const { service } = buildService({ repo });

    await expect(
      service.respondToInvitation('inv_1', { memberId: 'mem_owner' }, 'accept'),
    ).rejects.toThrow(ClubInvitationNotFoundError);
  });

  it('repeat responses are idempotent; crossed responses conflict', async () => {
    const repo = mockRepo();
    (repo.getInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(
      invitation({ status: 'accepted' }),
    );
    const { service, uow } = buildService({ repo });

    const result = await service.respondToInvitation('inv_1', { memberId: 'mem_9' }, 'accept');
    expect(result.status).toBe('accepted');
    expect(uow.execute).not.toHaveBeenCalled(); // pure no-op

    await expect(
      service.respondToInvitation('inv_1', { memberId: 'mem_9' }, 'decline'),
    ).rejects.toThrow(InvalidInvitationStateError);
  });

  it('a lost compare-and-set that agrees with the target is idempotent', async () => {
    const repo = mockRepo();
    (repo.getInvitation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(invitation()) // pre-check: pending
      .mockResolvedValueOnce(invitation({ status: 'accepted' })); // in-tx re-read
    (repo.transitionInvitation as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { service, audit } = buildService({ repo });

    const result = await service.respondToInvitation('inv_1', { memberId: 'mem_9' }, 'accept');
    expect(result.status).toBe('accepted');
    expect(auditEventTypes(audit)).toEqual([]); // the winner already audited
  });
});

describe('ClubService.createInviteLink', () => {
  it('members mint links; the raw token is returned and only the hash stored', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_2', 'member')]);
    const { service, audit } = buildService({ repo });

    const result = await service.createInviteLink('clb_1', { memberId: 'mem_2' }, {}, NOW);

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    const created = (repo.createInviteLink as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.tokenHash).not.toBe(result.token);
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000));
    expect(repo.revokeActiveInviteLinks).not.toHaveBeenCalled();
    expect(auditEventTypes(audit)).toEqual(['club.invite_link_created']);
  });

  it('rotate revokes the previous links and is owner-only', async () => {
    const repo = mockRepo();
    grantMemberships(repo, [membership('mem_owner', 'owner'), membership('mem_2', 'member')]);
    (repo.revokeActiveInviteLinks as ReturnType<typeof vi.fn>).mockResolvedValue(['cil_0']);
    const { service, audit } = buildService({ repo });

    await expect(
      service.createInviteLink('clb_1', { memberId: 'mem_2' }, { rotate: true }),
    ).rejects.toThrow(ClubPermissionError);

    await service.createInviteLink('clb_1', { memberId: 'mem_owner' }, { rotate: true }, NOW);
    expect(repo.revokeActiveInviteLinks).toHaveBeenCalledWith(expect.anything(), 'clb_1', NOW);
    expect(auditEventTypes(audit)).toEqual(['club.invite_link_revoked', 'club.invite_link_created']);
  });
});

describe('ClubService.joinViaLink', () => {
  it('joins, consumes a use, satisfies any pending invitation and audits', async () => {
    const repo = mockRepo();
    (repo.findInviteLinkByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(linkRecord());
    const { service, audit } = buildService({ repo });

    const result = await service.joinViaLink('token', { memberId: 'mem_9' }, NOW);

    expect(result.joined).toBe(true);
    expect(result.alreadyMember).toBe(false);
    expect(repo.consumeInviteLinkUse).toHaveBeenCalledWith(expect.anything(), 'cil_1', NOW);
    expect(repo.addMember).toHaveBeenCalledWith(expect.anything(), 'clb_1', 'mem_9', 'member');
    expect(repo.acceptPendingInvitationFor).toHaveBeenCalledWith(expect.anything(), 'clb_1', 'mem_9', NOW);
    expect(auditEventTypes(audit)).toEqual(['club.member_joined']);
  });

  it('is idempotent for an existing member and consumes nothing', async () => {
    const repo = mockRepo();
    (repo.findInviteLinkByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(linkRecord());
    grantMemberships(repo, [membership('mem_2', 'member')]);
    const { service } = buildService({ repo });

    const result = await service.joinViaLink('token', { memberId: 'mem_2' }, NOW);
    expect(result.joined).toBe(false);
    expect(result.alreadyMember).toBe(true);
    expect(repo.consumeInviteLinkUse).not.toHaveBeenCalled();
    expect(repo.addMember).not.toHaveBeenCalled();
  });

  it('a retry whose first attempt consumed the last use still answers success', async () => {
    const repo = mockRepo();
    // The first attempt joined AND exhausted the link; the response was lost.
    (repo.findInviteLinkByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(
      linkRecord({ maxUses: 1, useCount: 1 }),
    );
    grantMemberships(repo, [membership('mem_2', 'member')]);
    const { service } = buildService({ repo });

    const result = await service.joinViaLink('token', { memberId: 'mem_2' }, NOW);
    expect(result.alreadyMember).toBe(true);
    expect(repo.consumeInviteLinkUse).not.toHaveBeenCalled();
  });

  it('rejects unknown, revoked, expired and exhausted links', async () => {
    const repo = mockRepo();
    const { service } = buildService({ repo });
    const find = repo.findInviteLinkByTokenHash as ReturnType<typeof vi.fn>;

    find.mockResolvedValue(null);
    await expect(service.joinViaLink('token', { memberId: 'mem_9' }, NOW)).rejects.toThrow(
      InviteLinkInvalidError,
    );

    for (const dead of [
      linkRecord({ revokedAt: NOW }),
      linkRecord({ expiresAt: new Date(NOW.getTime() - 1) }),
      linkRecord({ maxUses: 2, useCount: 2 }),
    ]) {
      find.mockResolvedValue(dead);
      await expect(service.joinViaLink('token', { memberId: 'mem_9' }, NOW)).rejects.toThrow(
        InviteLinkInvalidError,
      );
      expect(repo.addMember).not.toHaveBeenCalled();
    }
  });

  it('a link that dies between read and consume is rejected with the fresh verdict', async () => {
    const repo = mockRepo();
    (repo.findInviteLinkByTokenHash as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(linkRecord({ maxUses: 5, useCount: 4 }))
      .mockResolvedValueOnce(linkRecord({ maxUses: 5, useCount: 5 }));
    (repo.consumeInviteLinkUse as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { service } = buildService({ repo });

    await expect(service.joinViaLink('token', { memberId: 'mem_9' }, NOW)).rejects.toThrow(
      'usage limit',
    );
    expect(repo.addMember).not.toHaveBeenCalled();
  });
});

describe('ClubService.previewInviteLink', () => {
  it('resolves a valid link to a club preview for a non-member', async () => {
    const repo = mockRepo();
    (repo.findInviteLinkByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(linkRecord());
    const { service } = buildService({ repo });

    const preview = await service.previewInviteLink('token', 'mem_9', NOW);
    expect(preview.club).toEqual({
      id: 'clb_1',
      name: 'baddies',
      description: null,
      coverImageUrl: null,
      memberCount: 2,
    });
    expect(preview.alreadyMember).toBe(false);
  });

  it('rejects a dead link', async () => {
    const repo = mockRepo();
    (repo.findInviteLinkByTokenHash as ReturnType<typeof vi.fn>).mockResolvedValue(
      linkRecord({ revokedAt: NOW }),
    );
    const { service } = buildService({ repo });
    await expect(service.previewInviteLink('token', 'mem_9', NOW)).rejects.toThrow(
      InviteLinkInvalidError,
    );
  });
});

describe('ClubService.releaseMemberForAccountDeletion (package E seam)', () => {
  it('transfers owned clubs to the longest-tenured member and removes plain memberships', async () => {
    const repo = mockRepo();
    (repo.listMembershipsForMember as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...membership('mem_gone', 'owner'), clubId: 'clb_1' },
      { ...membership('mem_gone', 'member'), clubId: 'clb_2' },
    ]);
    (repo.getMembership as ReturnType<typeof vi.fn>).mockImplementation(
      async (clubId: string) =>
        clubId === 'clb_1' ? membership('mem_gone', 'owner') : membership('mem_gone', 'member'),
    );
    (repo.listRoster as ReturnType<typeof vi.fn>).mockResolvedValue([
      rosterRow('mem_gone', 'owner', new Date('2026-01-01T00:00:00Z')),
      rosterRow('mem_late', 'member', new Date('2026-03-01T00:00:00Z')),
      rosterRow('mem_early', 'member', new Date('2026-02-01T00:00:00Z')),
    ]);
    const { service, audit } = buildService({ repo });

    const summary = await service.releaseMemberForAccountDeletion('mem_gone', 'usr_gone');

    expect(summary.transferred).toEqual([{ clubId: 'clb_1', toMemberId: 'mem_early' }]);
    expect(summary.leftClubIds).toEqual(['clb_2']);
    expect(summary.deletedClubIds).toEqual([]);
    expect(repo.setMemberRole).toHaveBeenCalledWith(expect.anything(), 'clb_1', 'mem_early', 'owner');
    expect(auditEventTypes(audit)).toEqual(
      expect.arrayContaining(['club.ownership_transferred', 'club.member_left']),
    );
  });

  it('deletes a club whose owner was the last member', async () => {
    const repo = mockRepo();
    (repo.listMembershipsForMember as ReturnType<typeof vi.fn>).mockResolvedValue([
      membership('mem_gone', 'owner'),
    ]);
    (repo.getMembership as ReturnType<typeof vi.fn>).mockResolvedValue(membership('mem_gone', 'owner'));
    (repo.listRoster as ReturnType<typeof vi.fn>).mockResolvedValue([rosterRow('mem_gone', 'owner')]);
    (repo.getClub as ReturnType<typeof vi.fn>).mockResolvedValue(
      clubRecord({ coverImageUrl: '/uploads/event-images/cover.jpg' }),
    );
    const { service, coverStore, audit } = buildService({ repo });

    const summary = await service.releaseMemberForAccountDeletion('mem_gone');

    expect(summary.deletedClubIds).toEqual(['clb_1']);
    expect(repo.deleteClub).toHaveBeenCalledWith(expect.anything(), 'clb_1');
    expect(coverStore.deleteManagedAsset).toHaveBeenCalledWith('/uploads/event-images/cover.jpg');
    expect(auditEventTypes(audit)).toEqual(['club.deleted']);
  });

  it('withdraws pending invitations in both directions', async () => {
    const repo = mockRepo();
    (repo.withdrawPendingInvitationsBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      invitation({ id: 'inv_sent' }),
    ]);
    (repo.withdrawPendingInvitationsTo as ReturnType<typeof vi.fn>).mockResolvedValue([
      invitation({ id: 'inv_recv', inviteeMemberId: 'mem_gone' }),
    ]);
    const { service, audit } = buildService({ repo });

    const summary = await service.releaseMemberForAccountDeletion('mem_gone');

    expect(summary.withdrawnSentInvitations).toBe(1);
    expect(summary.withdrawnReceivedInvitations).toBe(1);
    expect(auditEventTypes(audit)).toEqual([
      'club.invitation_withdrawn',
      'club.invitation_withdrawn',
    ]);
  });

  it('revokes every live share link the member minted (in any club) and audits it', async () => {
    const repo = mockRepo();
    (repo.revokeInviteLinksCreatedBy as ReturnType<typeof vi.fn>).mockResolvedValue(['clb_1', 'clb_2']);
    const { service, audit } = buildService({ repo });

    const summary = await service.releaseMemberForAccountDeletion('mem_gone');

    expect(repo.revokeInviteLinksCreatedBy).toHaveBeenCalledWith(
      expect.anything(),
      'mem_gone',
      expect.any(Date),
    );
    expect(summary.revokedInviteLinkClubIds).toEqual(['clb_1', 'clb_2']);
    expect(auditEventTypes(audit)).toEqual([
      'club.invite_links_revoked',
      'club.invite_links_revoked',
    ]);
  });
});
