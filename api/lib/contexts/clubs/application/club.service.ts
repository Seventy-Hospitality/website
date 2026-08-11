import type { TransactionContext, UnitOfWork } from '@/lib/kernel';
import { generateToken, hashToken } from '@/lib/contexts/identity/domain';
import {
  type ClubInvitationResponse,
  type ClubRole,
  applyInvitationResponse,
  applyRoleChange,
  assertCanLeave,
  assertRemovable,
  canPerform,
  clubInvariants,
  evaluateInviteLink,
  inviteLinkExpiry,
  pickSuccessor,
  ClubInvitationNotFoundError,
  ClubInviteeNotFoundError,
  ClubMemberNotFoundError,
  ClubNotFoundError,
  ClubPermissionError,
  InvalidInvitationStateError,
  InviteLinkInvalidError,
} from '../domain';
import type {
  ClubInvitationRecord,
  ClubMemberRecord,
  ClubRecord,
  ClubRepository,
} from '../infrastructure/club.repository';
import type { AuditLog, ManagedCoverImageStore } from './ports';

const STREAM_TYPE = 'club';

/** The acting member; actorId is the principal's USER id for the audit log. */
export interface ClubActor {
  memberId: string;
  actorId?: string;
}

export interface ClubSummary {
  id: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  memberCount: number;
}

export interface MyClubItem extends ClubSummary {
  myRole: ClubRole;
  joinedAt: Date;
  createdAt: Date;
}

export interface ClubPermissionFlags {
  canEdit: boolean;
  canDelete: boolean;
  canManageMembers: boolean;
  canInvite: boolean;
  /** True only when leaving will actually succeed (the owner must transfer). */
  canLeave: boolean;
}

export interface ClubDetail extends ClubSummary {
  myRole: ClubRole;
  permissions: ClubPermissionFlags;
  createdAt: Date;
  updatedAt: Date;
}

export interface RosterEntry {
  memberId: string;
  /** The human-facing member number ("#A12345" without the hash). */
  memberNumber: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: ClubRole;
  joinedAt: Date;
}

export interface PendingInvitationItem {
  id: string;
  club: ClubSummary;
  invitedBy: { memberId: string; firstName: string; lastName: string } | null;
  createdAt: Date;
}

export interface InviteLinkResult {
  token: string;
  expiresAt: Date | null;
  maxUses: number | null;
}

export interface JoinResult {
  club: ClubSummary;
  joined: boolean;
  alreadyMember: boolean;
}

export interface AccountDeletionClubsSummary {
  leftClubIds: string[];
  transferred: Array<{ clubId: string; toMemberId: string }>;
  deletedClubIds: string[];
  withdrawnSentInvitations: number;
  withdrawnReceivedInvitations: number;
}

/**
 * Member-created social clubs. The route policy only establishes "is a
 * member of the facility"; EVERY club-level decision (member vs owner vs
 * outsider) is re-derived here from club_members, so a forged id answers
 * 404 for outsiders and 403 for members lacking the role, never data.
 */
export class ClubService {
  constructor(
    private readonly repo: ClubRepository,
    private readonly coverStore: ManagedCoverImageStore,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  // ── Reads ──

  async listForMember(memberId: string): Promise<MyClubItem[]> {
    const rows = await this.repo.listForMember(memberId);
    return rows.map((row) => ({
      ...toSummary(row.club, row.memberCount),
      myRole: row.role,
      joinedAt: row.joinedAt,
      createdAt: row.club.createdAt,
    }));
  }

  async getForViewer(clubId: string, viewerMemberId: string): Promise<ClubDetail> {
    const { club, membership } = await this.requireMembership(clubId, viewerMemberId);
    const memberCount = await this.repo.countMembers(clubId);
    return {
      ...toSummary(club, memberCount),
      myRole: membership.role,
      permissions: {
        canEdit: canPerform(membership.role, 'edit'),
        canDelete: canPerform(membership.role, 'delete'),
        canManageMembers: canPerform(membership.role, 'removeMember'),
        canInvite: canPerform(membership.role, 'invite'),
        canLeave: membership.role !== 'owner',
      },
      createdAt: club.createdAt,
      updatedAt: club.updatedAt,
    };
  }

  async listMembers(clubId: string, viewerMemberId: string): Promise<RosterEntry[]> {
    await this.requireMembership(clubId, viewerMemberId);
    const roster = await this.repo.listRoster(clubId);
    // Owner first, then tenure: the roster screen's badge order.
    return roster
      .sort((a, b) =>
        a.role === b.role
          ? a.joinedAt.getTime() - b.joinedAt.getTime() || a.memberId.localeCompare(b.memberId)
          : a.role === 'owner'
            ? -1
            : 1,
      )
      .map((row) => ({
        memberId: row.memberId,
        memberNumber: row.member.memberNumber,
        firstName: row.member.firstName,
        lastName: row.member.lastName,
        displayName: row.member.displayName,
        avatarUrl: row.member.avatarUrl,
        role: row.role,
        joinedAt: row.joinedAt,
      }));
  }

  /** Club-member gate for reads served by other contexts (activity feed). */
  async assertMember(clubId: string, memberId: string): Promise<void> {
    await this.requireMembership(clubId, memberId);
  }

  // ── Create / edit / delete ──

  async create(
    input: { name: string; description?: string | null; inviteeMemberIds?: string[] },
    actor: ClubActor,
  ): Promise<{ club: ClubSummary; invited: string[] }> {
    clubInvariants.validateName(input.name);
    clubInvariants.validateDescription(input.description);

    const inviteeIds = [...new Set(input.inviteeMemberIds ?? [])].filter(
      (id) => id !== actor.memberId,
    );
    await this.assertInviteesExist(inviteeIds);

    const actorId = actor.actorId ?? actor.memberId;
    const { club, invited } = await this.uow.execute(async (tx) => {
      const created = await this.repo.createClub(tx, {
        name: input.name.trim(),
        description: input.description?.trim() || null,
        createdById: actor.memberId,
      });
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: created.id,
        eventType: 'club.created',
        data: { name: created.name, createdById: actor.memberId },
        actorId,
      });

      const invitedIds: string[] = [];
      for (const inviteeMemberId of inviteeIds) {
        const invitation = await this.repo.createInvitation(tx, {
          clubId: created.id,
          inviterId: actor.memberId,
          inviteeMemberId,
        });
        if (!invitation) continue;
        // TODO(package-f): notification send rides the outbox row below.
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: created.id,
          eventType: 'club.invitation_sent',
          data: { invitationId: invitation.id, inviteeMemberId, inviterId: actor.memberId },
          actorId,
        });
        invitedIds.push(inviteeMemberId);
      }

      return { club: created, invited: invitedIds };
    });

    return { club: toSummary(club, 1), invited };
  }

  async update(
    clubId: string,
    actor: ClubActor,
    input: { name?: string; description?: string | null; coverImageUrl?: null },
  ): Promise<ClubSummary> {
    const { club } = await this.requireOwner(clubId, actor.memberId);
    if (input.name !== undefined) clubInvariants.validateName(input.name);
    if (input.description !== undefined) clubInvariants.validateDescription(input.description);

    const data: { name?: string; description?: string | null; coverImageUrl?: null } = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    // Only explicit removal comes through PATCH; a new cover arrives via the
    // multipart upload endpoint, which owns the asset lifecycle.
    if (input.coverImageUrl === null) data.coverImageUrl = null;

    const updated = await this.uow.execute(async (tx) => {
      const row = await this.repo.updateClub(tx, clubId, data);
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: clubId,
        eventType: 'club.updated',
        data: { fields: Object.keys(data) },
        actorId: actor.actorId ?? actor.memberId,
      });
      return row;
    });

    if (data.coverImageUrl === null && club.coverImageUrl) {
      await this.coverStore.deleteManagedAsset(club.coverImageUrl);
    }

    const memberCount = await this.repo.countMembers(clubId);
    return toSummary(updated, memberCount);
  }

  /**
   * Multipart cover upload through the media context's ManagedMediaAsset
   * pipeline (same pattern as event images): upload + pending row, point the
   * club at it, attach the asset to its owner, drop any replaced cover.
   */
  async setCoverImage(
    clubId: string,
    actor: ClubActor,
    upload: { filename: string; contentType: string; bytes: Buffer },
  ): Promise<ClubSummary> {
    const { club } = await this.requireOwner(clubId, actor.memberId);

    const asset = await this.coverStore.uploadCoverImage(upload);
    const updated = await this.uow.execute(async (tx) => {
      const row = await this.repo.updateClub(tx, clubId, { coverImageUrl: asset.publicPath });
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: clubId,
        eventType: 'club.updated',
        data: { fields: ['coverImageUrl'] },
        actorId: actor.actorId ?? actor.memberId,
      });
      return row;
    });
    await this.coverStore.attachManagedAssetToOwner(asset.publicPath, {
      ownerType: 'club',
      ownerId: clubId,
    });
    if (club.coverImageUrl && club.coverImageUrl !== asset.publicPath) {
      await this.coverStore.deleteManagedAsset(club.coverImageUrl);
    }

    const memberCount = await this.repo.countMembers(clubId);
    return toSummary(updated, memberCount);
  }

  async delete(clubId: string, actor: ClubActor): Promise<void> {
    const { club } = await this.requireOwner(clubId, actor.memberId);

    await this.uow.execute(async (tx) => {
      await this.repo.advisoryLockClub(tx, clubId);
      // Re-verify under the lock: a concurrent transfer may have demoted us.
      const fresh = await this.repo.getMembership(clubId, actor.memberId, tx);
      if (!fresh) throw new ClubNotFoundError(clubId);
      if (fresh.role !== 'owner') throw new ClubPermissionError('Only the club owner can delete the club');

      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: clubId,
        eventType: 'club.deleted',
        data: { name: club.name },
        actorId: actor.actorId ?? actor.memberId,
      });
      // Members, invitations and links cascade; reservations unlink.
      await this.repo.deleteClub(tx, clubId);
    });

    await this.coverStore.deleteManagedAsset(club.coverImageUrl);
  }

  // ── Membership ──

  async leave(clubId: string, actor: ClubActor): Promise<void> {
    const { membership } = await this.requireMembership(clubId, actor.memberId);
    assertCanLeave(membership.role);

    await this.uow.execute(async (tx) => {
      await this.repo.advisoryLockClub(tx, clubId);
      const fresh = await this.repo.getMembership(clubId, actor.memberId, tx);
      if (!fresh) return; // already gone: leaving twice is not an error
      assertCanLeave(fresh.role); // ownership may have been transferred TO us meanwhile

      await this.repo.removeMember(tx, clubId, actor.memberId);
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: clubId,
        eventType: 'club.member_left',
        data: { memberId: actor.memberId },
        actorId: actor.actorId ?? actor.memberId,
      });
    });
  }

  async changeMemberRole(
    clubId: string,
    actor: ClubActor,
    targetMemberId: string,
    newRole: ClubRole,
  ): Promise<void> {
    await this.requireOwner(clubId, actor.memberId);

    await this.uow.execute(async (tx) => {
      await this.repo.advisoryLockClub(tx, clubId);
      const actorRow = await this.repo.getMembership(clubId, actor.memberId, tx);
      if (!actorRow) throw new ClubNotFoundError(clubId);
      const targetRow = await this.repo.getMembership(clubId, targetMemberId, tx);
      if (!targetRow) throw new ClubMemberNotFoundError();

      const changes = applyRoleChange(actorRow, targetRow, newRole);
      for (const change of changes) {
        await this.repo.setMemberRole(tx, clubId, change.memberId, change.role);
      }
      if (changes.some((change) => change.role === 'owner')) {
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: clubId,
          eventType: 'club.ownership_transferred',
          data: { fromMemberId: actor.memberId, toMemberId: targetMemberId },
          actorId: actor.actorId ?? actor.memberId,
        });
      }
    });
  }

  async removeMember(clubId: string, actor: ClubActor, targetMemberId: string): Promise<void> {
    await this.requireOwner(clubId, actor.memberId);

    await this.uow.execute(async (tx) => {
      await this.repo.advisoryLockClub(tx, clubId);
      const actorRow = await this.repo.getMembership(clubId, actor.memberId, tx);
      if (!actorRow) throw new ClubNotFoundError(clubId);
      const targetRow = await this.repo.getMembership(clubId, targetMemberId, tx);
      if (!targetRow) throw new ClubMemberNotFoundError();
      assertRemovable(actorRow, targetRow);

      await this.repo.removeMember(tx, clubId, targetMemberId);
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: clubId,
        eventType: 'club.member_removed',
        data: { memberId: targetMemberId, removedById: actor.memberId },
        actorId: actor.actorId ?? actor.memberId,
      });
    });
  }

  // ── Invitations (require acceptance; plan OPEN decision 4) ──

  async invite(
    clubId: string,
    actor: ClubActor,
    memberIds: string[],
  ): Promise<{ invited: string[] }> {
    await this.requireMembership(clubId, actor.memberId);
    const requested = [...new Set(memberIds)].filter((id) => id !== actor.memberId);
    await this.assertInviteesExist(requested);

    const actorId = actor.actorId ?? actor.memberId;
    return this.uow.execute(async (tx) => {
      await this.repo.advisoryLockClub(tx, clubId);
      const roster = new Set(
        (await this.repo.listRoster(clubId, tx)).map((row) => row.memberId),
      );
      const pending = await this.repo.listPendingInviteeIds(clubId, tx);

      const invited: string[] = [];
      for (const inviteeMemberId of requested) {
        // Already in, or already holding a live invite: a silent no-op, so
        // "invite all" never trips over the partial unique index.
        if (roster.has(inviteeMemberId) || pending.has(inviteeMemberId)) continue;

        const invitation = await this.repo.createInvitation(tx, {
          clubId,
          inviterId: actor.memberId,
          inviteeMemberId,
        });
        if (!invitation) continue; // raced another inviter
        // TODO(package-f): notification send rides the outbox row below.
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: clubId,
          eventType: 'club.invitation_sent',
          data: { invitationId: invitation.id, inviteeMemberId, inviterId: actor.memberId },
          actorId,
        });
        invited.push(inviteeMemberId);
      }

      return { invited };
    });
  }

  async listMyInvitations(memberId: string): Promise<PendingInvitationItem[]> {
    const rows = await this.repo.listPendingForInvitee(memberId);
    return rows.map((row) => ({
      id: row.id,
      club: {
        id: row.club.id,
        name: row.club.name,
        description: row.club.description,
        coverImageUrl: row.club.coverImageUrl,
        memberCount: row.clubMemberCount,
      },
      invitedBy: row.inviter
        ? { memberId: row.inviter.id, firstName: row.inviter.firstName, lastName: row.inviter.lastName }
        : null,
      createdAt: row.createdAt,
    }));
  }

  /** Only the invitee may respond; anyone else gets the 404 shape. */
  async respondToInvitation(
    invitationId: string,
    actor: ClubActor,
    response: ClubInvitationResponse,
  ): Promise<{ status: string; clubId: string }> {
    const invitation = await this.repo.getInvitation(invitationId);
    if (!invitation || invitation.inviteeMemberId !== actor.memberId) {
      throw new ClubInvitationNotFoundError(invitationId);
    }

    const next = applyInvitationResponse(invitation.status, response);
    if (next === invitation.status) return { status: next, clubId: invitation.clubId }; // idempotent

    const actorId = actor.actorId ?? actor.memberId;
    const now = new Date();
    await this.uow.execute(async (tx) => {
      await this.repo.advisoryLockClub(tx, invitation.clubId);
      const transitioned = await this.repo.transitionInvitation(tx, invitationId, next, now);
      if (!transitioned) {
        // Lost a race: surface the truth (idempotent when it agrees).
        const fresh = await this.repo.getInvitation(invitationId, tx);
        if (fresh?.status === next) return;
        throw new InvalidInvitationStateError(fresh?.status ?? 'missing', response);
      }

      if (next === 'accepted') {
        const added = await this.repo.addMember(tx, invitation.clubId, actor.memberId, 'member');
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: invitation.clubId,
          eventType: 'club.invitation_accepted',
          data: { invitationId, inviteeMemberId: actor.memberId },
          actorId,
        });
        if (added) {
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: invitation.clubId,
            eventType: 'club.member_joined',
            data: { memberId: actor.memberId, via: 'invitation' },
            actorId,
          });
        }
      } else {
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: invitation.clubId,
          eventType: 'club.invitation_declined',
          data: { invitationId, inviteeMemberId: actor.memberId },
          actorId,
        });
      }
    });

    return { status: next, clubId: invitation.clubId };
  }

  // ── Invite links (share link + QR) ──

  /**
   * Mint a share link. Any club member may create one (the invite modal is
   * open to members); `rotate` additionally revokes every other active link
   * of the club and is owner-only, which is how a leaked link is killed.
   * The raw token is returned exactly once; only its sha256 is stored.
   */
  async createInviteLink(
    clubId: string,
    actor: ClubActor,
    options: { expiresInDays?: number; maxUses?: number; rotate?: boolean } = {},
    now: Date = new Date(),
  ): Promise<InviteLinkResult> {
    const { membership } = await this.requireMembership(clubId, actor.memberId);
    if (options.rotate && membership.role !== 'owner') {
      throw new ClubPermissionError('Only the club owner can revoke existing invite links');
    }

    const { token, hash } = generateToken();
    const expiresAt = inviteLinkExpiry(now, options.expiresInDays);
    const maxUses = options.maxUses ?? null;
    const actorId = actor.actorId ?? actor.memberId;

    await this.uow.execute(async (tx) => {
      if (options.rotate) {
        const revokedIds = await this.repo.revokeActiveInviteLinks(tx, clubId, now);
        if (revokedIds.length > 0) {
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: clubId,
            eventType: 'club.invite_link_revoked',
            data: { linkIds: revokedIds, reason: 'rotated' },
            actorId,
          });
        }
      }
      const link = await this.repo.createInviteLink(tx, {
        clubId,
        tokenHash: hash,
        createdById: actor.memberId,
        expiresAt,
        maxUses,
      });
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: clubId,
        eventType: 'club.invite_link_created',
        data: { linkId: link.id, expiresAt: expiresAt?.toISOString() ?? null, maxUses },
        actorId,
      });
    });

    return { token, expiresAt, maxUses };
  }

  /** Resolve a link/QR to a club preview for the join screen. */
  async previewInviteLink(
    token: string,
    viewerMemberId: string,
    now: Date = new Date(),
  ): Promise<{ club: ClubSummary; alreadyMember: boolean }> {
    const link = await this.repo.findInviteLinkByTokenHash(hashToken(token));
    if (!link) throw new InviteLinkInvalidError('invalid');
    const verdict = evaluateInviteLink(link, now);
    if (verdict !== 'valid') throw new InviteLinkInvalidError(verdict);

    const club = await this.repo.getClub(link.clubId);
    if (!club) throw new InviteLinkInvalidError('invalid');
    const [memberCount, membership] = await Promise.all([
      this.repo.countMembers(link.clubId),
      this.repo.getMembership(link.clubId, viewerMemberId),
    ]);
    return { club: toSummary(club, memberCount), alreadyMember: membership !== null };
  }

  /**
   * Join via link/QR. Idempotent: an existing member answers success without
   * consuming a use, and BEFORE the link verdict, so a retry whose first
   * attempt consumed the last use (or preceded a rotation) still succeeds
   * instead of answering 410. Expiry/maxUses/revocation are re-checked
   * inside the consuming UPDATE, so racing joins cannot overshoot a limit.
   */
  async joinViaLink(token: string, actor: ClubActor, now: Date = new Date()): Promise<JoinResult> {
    const link = await this.repo.findInviteLinkByTokenHash(hashToken(token));
    if (!link) throw new InviteLinkInvalidError('invalid');

    const preexisting = await this.repo.getMembership(link.clubId, actor.memberId);
    if (!preexisting) {
      const verdict = evaluateInviteLink(link, now);
      if (verdict !== 'valid') throw new InviteLinkInvalidError(verdict);
    }

    const actorId = actor.actorId ?? actor.memberId;
    const joined = await this.uow.execute(async (tx) => {
      await this.repo.advisoryLockClub(tx, link.clubId);
      const existing = await this.repo.getMembership(link.clubId, actor.memberId, tx);
      if (existing) return false;

      const consumed = await this.repo.consumeInviteLinkUse(tx, link.id, now);
      if (!consumed) {
        // The link died between read and consume; report the exact reason.
        const fresh = await this.repo.findInviteLinkByTokenHash(link.tokenHash);
        const freshVerdict = fresh ? evaluateInviteLink(fresh, now) : 'invalid';
        throw new InviteLinkInvalidError(freshVerdict === 'valid' ? 'exhausted' : freshVerdict);
      }

      await this.repo.addMember(tx, link.clubId, actor.memberId, 'member');
      // Joining via link satisfies any live invitation to the same club.
      await this.repo.acceptPendingInvitationFor(tx, link.clubId, actor.memberId, now);
      await this.audit.append(tx, {
        streamType: STREAM_TYPE,
        streamId: link.clubId,
        eventType: 'club.member_joined',
        data: { memberId: actor.memberId, via: 'link', linkId: link.id },
        actorId,
      });
      return true;
    });

    const club = await this.repo.getClub(link.clubId);
    if (!club) throw new InviteLinkInvalidError('invalid'); // deleted mid-flight
    const memberCount = await this.repo.countMembers(link.clubId);
    return { club: toSummary(club, memberCount), joined, alreadyMember: !joined };
  }

  // ── Account-deletion seam (package E) ──

  /**
   * TODO(package-e): the account-deletion pipeline calls this to settle a
   * deleting member's clubs BEFORE the member row is anonymized.
   *
   * Per the identity critique: owner deletion must never orphan a club.
   * Ownership transfers to the longest-tenured remaining member (ties break
   * on member id); a club with nobody left is deleted. Plain memberships
   * are removed, and every pending invitation the member sent or received
   * is withdrawn. One transaction; clubs lock in sorted-id order.
   */
  async releaseMemberForAccountDeletion(
    memberId: string,
    actorId?: string,
  ): Promise<AccountDeletionClubsSummary> {
    const coversToDelete: string[] = [];
    const summary = await this.uow.execute(async (tx) => {
      const result: AccountDeletionClubsSummary = {
        leftClubIds: [],
        transferred: [],
        deletedClubIds: [],
        withdrawnSentInvitations: 0,
        withdrawnReceivedInvitations: 0,
      };
      const now = new Date();
      const memberships = await this.repo.listMembershipsForMember(memberId, tx); // sorted by clubId

      for (const membership of memberships) {
        await this.repo.advisoryLockClub(tx, membership.clubId);
        const fresh = await this.repo.getMembership(membership.clubId, memberId, tx);
        if (!fresh) continue;

        if (fresh.role !== 'owner') {
          await this.repo.removeMember(tx, membership.clubId, memberId);
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: membership.clubId,
            eventType: 'club.member_left',
            data: { memberId, reason: 'account_deletion' },
            actorId,
          });
          result.leftClubIds.push(membership.clubId);
          continue;
        }

        const remaining = (await this.repo.listRoster(membership.clubId, tx)).filter(
          (row) => row.memberId !== memberId,
        );
        const successor = pickSuccessor(remaining);
        if (!successor) {
          const club = await this.repo.getClub(membership.clubId, tx);
          if (club?.coverImageUrl) coversToDelete.push(club.coverImageUrl);
          await this.audit.append(tx, {
            streamType: STREAM_TYPE,
            streamId: membership.clubId,
            eventType: 'club.deleted',
            data: { name: club?.name ?? null, reason: 'account_deletion' },
            actorId,
          });
          await this.repo.deleteClub(tx, membership.clubId);
          result.deletedClubIds.push(membership.clubId);
          continue;
        }

        await this.repo.setMemberRole(tx, membership.clubId, successor.memberId, 'owner');
        await this.repo.removeMember(tx, membership.clubId, memberId);
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: membership.clubId,
          eventType: 'club.ownership_transferred',
          data: { fromMemberId: memberId, toMemberId: successor.memberId, reason: 'account_deletion' },
          actorId,
        });
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: membership.clubId,
          eventType: 'club.member_left',
          data: { memberId, reason: 'account_deletion' },
          actorId,
        });
        result.transferred.push({ clubId: membership.clubId, toMemberId: successor.memberId });
      }

      const withdrawnSent = await this.repo.withdrawPendingInvitationsBy(tx, memberId, now);
      const withdrawnReceived = await this.repo.withdrawPendingInvitationsTo(tx, memberId, now);
      for (const invitation of [...withdrawnSent, ...withdrawnReceived]) {
        await this.audit.append(tx, {
          streamType: STREAM_TYPE,
          streamId: invitation.clubId,
          eventType: 'club.invitation_withdrawn',
          data: {
            invitationId: invitation.id,
            inviteeMemberId: invitation.inviteeMemberId,
            reason: 'account_deletion',
          },
          actorId,
        });
      }
      result.withdrawnSentInvitations = withdrawnSent.length;
      result.withdrawnReceivedInvitations = withdrawnReceived.length;

      return result;
    });

    for (const cover of coversToDelete) {
      await this.coverStore.deleteManagedAsset(cover);
    }
    return summary;
  }

  // ── Internals ──

  /**
   * Resource-level gate: the caller must be a club member. A missing club
   * and a club the caller is not in answer identically (404 shape).
   */
  private async requireMembership(
    clubId: string,
    memberId: string,
    tx?: TransactionContext,
  ): Promise<{ club: ClubRecord; membership: ClubMemberRecord }> {
    const [club, membership] = await Promise.all([
      this.repo.getClub(clubId, tx),
      this.repo.getMembership(clubId, memberId, tx),
    ]);
    if (!club || !membership) throw new ClubNotFoundError(clubId);
    return { club, membership };
  }

  /** Owner gate: member sees 403, outsider still sees 404. */
  private async requireOwner(
    clubId: string,
    memberId: string,
    tx?: TransactionContext,
  ): Promise<{ club: ClubRecord; membership: ClubMemberRecord }> {
    const found = await this.requireMembership(clubId, memberId, tx);
    if (found.membership.role !== 'owner') throw new ClubPermissionError();
    return found;
  }

  private async assertInviteesExist(memberIds: string[]): Promise<void> {
    if (memberIds.length === 0) return;
    const existing = await this.repo.filterExistingMemberIds(memberIds);
    const missing = memberIds.filter((id) => !existing.has(id));
    if (missing.length > 0) throw new ClubInviteeNotFoundError(missing);
  }
}

function toSummary(club: ClubRecord, memberCount: number): ClubSummary {
  return {
    id: club.id,
    name: club.name,
    description: club.description,
    coverImageUrl: club.coverImageUrl,
    memberCount,
  };
}
