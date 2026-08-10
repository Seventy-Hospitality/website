import type { PrismaClient } from '@prisma/client';
import type { TransactionContext } from '@/lib/kernel';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { ClubInvitationStatus, ClubRole } from '../domain';

// ── Records ──

export interface ClubRecord {
  id: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClubMemberRecord {
  id: string;
  clubId: string;
  memberId: string;
  role: ClubRole;
  joinedAt: Date;
}

export interface ClubRosterRow extends ClubMemberRecord {
  member: { id: string; firstName: string; lastName: string };
}

export interface MyClubRow {
  club: ClubRecord;
  role: ClubRole;
  joinedAt: Date;
  memberCount: number;
}

export interface ClubInvitationRecord {
  id: string;
  clubId: string;
  inviterId: string;
  inviteeMemberId: string;
  status: ClubInvitationStatus;
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingInvitationRow extends ClubInvitationRecord {
  club: { id: string; name: string; description: string | null; coverImageUrl: string | null };
  clubMemberCount: number;
  inviter: { id: string; firstName: string; lastName: string } | null;
}

export interface ClubInviteLinkRecord {
  id: string;
  clubId: string;
  tokenHash: string;
  createdById: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  maxUses: number | null;
  useCount: number;
  createdAt: Date;
}

function isDuplicateKeyError(err: unknown): boolean {
  return err != null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002';
}

export class ClubRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private db(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  /**
   * Serialize the mutating paths of ONE club (join, leave, transfer, remove,
   * respond-accept, delete). Roster reads inside such a transaction then see
   * settled state, which is what lets the single-owner invariant live in
   * pure functions instead of constraints. Multi-club transactions (the
   * account-deletion seam) must lock clubs in sorted-id order.
   */
  async advisoryLockClub(tx: TransactionContext, clubId: string): Promise<void> {
    const key = `club:${clubId}`;
    await asPrismaTx(tx).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  // ── Clubs ──

  async createClub(
    tx: TransactionContext,
    input: { name: string; description: string | null; createdById: string },
  ): Promise<ClubRecord> {
    const club = await asPrismaTx(tx).club.create({
      data: {
        name: input.name,
        description: input.description,
        createdById: input.createdById,
        members: { create: { memberId: input.createdById, role: 'owner' } },
      },
    });
    return club as ClubRecord;
  }

  async getClub(id: string, tx?: TransactionContext): Promise<ClubRecord | null> {
    return this.db(tx).club.findUnique({ where: { id } }) as Promise<ClubRecord | null>;
  }

  async updateClub(
    tx: TransactionContext | undefined,
    id: string,
    data: { name?: string; description?: string | null; coverImageUrl?: string | null },
  ): Promise<ClubRecord> {
    return this.db(tx).club.update({ where: { id }, data }) as Promise<ClubRecord>;
  }

  async deleteClub(tx: TransactionContext, id: string): Promise<void> {
    // Members, invitations and links cascade; reservations/participants
    // unlink via ON DELETE SET NULL.
    await asPrismaTx(tx).club.delete({ where: { id } });
  }

  async countMembers(clubId: string, tx?: TransactionContext): Promise<number> {
    return this.db(tx).clubMember.count({ where: { clubId } });
  }

  // ── Memberships ──

  async listForMember(memberId: string): Promise<MyClubRow[]> {
    const rows = await this.prisma.clubMember.findMany({
      where: { memberId },
      include: { club: { include: { _count: { select: { members: true } } } } },
      orderBy: { joinedAt: 'asc' },
    });
    return rows.map((row) => {
      const { _count, ...club } = row.club;
      return {
        club: club as ClubRecord,
        role: row.role as ClubRole,
        joinedAt: row.joinedAt,
        memberCount: _count.members,
      };
    });
  }

  async getMembership(
    clubId: string,
    memberId: string,
    tx?: TransactionContext,
  ): Promise<ClubMemberRecord | null> {
    return this.db(tx).clubMember.findUnique({
      where: { clubId_memberId: { clubId, memberId } },
    }) as Promise<ClubMemberRecord | null>;
  }

  async listRoster(clubId: string, tx?: TransactionContext): Promise<ClubRosterRow[]> {
    return this.db(tx).clubMember.findMany({
      where: { clubId },
      include: { member: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: [{ joinedAt: 'asc' }, { memberId: 'asc' }],
    }) as Promise<ClubRosterRow[]>;
  }

  /** True when the row was created; false when the member already was one. */
  async addMember(
    tx: TransactionContext,
    clubId: string,
    memberId: string,
    role: ClubRole,
  ): Promise<boolean> {
    try {
      await asPrismaTx(tx).clubMember.create({ data: { clubId, memberId, role } });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async removeMember(tx: TransactionContext, clubId: string, memberId: string): Promise<void> {
    await asPrismaTx(tx).clubMember.deleteMany({ where: { clubId, memberId } });
  }

  async setMemberRole(
    tx: TransactionContext,
    clubId: string,
    memberId: string,
    role: ClubRole,
  ): Promise<void> {
    await asPrismaTx(tx).clubMember.update({
      where: { clubId_memberId: { clubId, memberId } },
      data: { role },
    });
  }

  /** Club memberships of one member, for the account-deletion seam. */
  async listMembershipsForMember(
    memberId: string,
    tx?: TransactionContext,
  ): Promise<ClubMemberRecord[]> {
    return this.db(tx).clubMember.findMany({
      where: { memberId },
      orderBy: { clubId: 'asc' }, // deterministic lock order for multi-club runs
    }) as Promise<ClubMemberRecord[]>;
  }

  // ── Invitations ──

  /**
   * The fresh pending invitation, or null when one already exists (the
   * partial unique index arbitrates the race).
   */
  async createInvitation(
    tx: TransactionContext,
    input: { clubId: string; inviterId: string; inviteeMemberId: string },
  ): Promise<ClubInvitationRecord | null> {
    try {
      return (await asPrismaTx(tx).clubInvitation.create({ data: input })) as ClubInvitationRecord;
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  }

  async getInvitation(id: string, tx?: TransactionContext): Promise<ClubInvitationRecord | null> {
    return this.db(tx).clubInvitation.findUnique({ where: { id } }) as Promise<ClubInvitationRecord | null>;
  }

  /** Compare-and-set from pending; false = the row already left pending. */
  async transitionInvitation(
    tx: TransactionContext,
    id: string,
    to: ClubInvitationStatus,
    respondedAt: Date,
  ): Promise<boolean> {
    const updated = await asPrismaTx(tx).clubInvitation.updateMany({
      where: { id, status: 'pending' },
      data: { status: to, respondedAt },
    });
    return updated.count > 0;
  }

  async listPendingForInvitee(memberId: string): Promise<PendingInvitationRow[]> {
    const rows = await this.prisma.clubInvitation.findMany({
      where: { inviteeMemberId: memberId, status: 'pending' },
      include: {
        club: {
          select: {
            id: true,
            name: true,
            description: true,
            coverImageUrl: true,
            _count: { select: { members: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const inviterIds = [...new Set(rows.map((row) => row.inviterId))];
    const inviters = inviterIds.length
      ? await this.prisma.member.findMany({
          where: { id: { in: inviterIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const inviterById = new Map(inviters.map((member) => [member.id, member]));

    return rows.map((row) => {
      const { club, ...invitation } = row;
      const { _count, ...clubFields } = club;
      return {
        ...(invitation as ClubInvitationRecord),
        club: clubFields,
        clubMemberCount: _count.members,
        inviter: inviterById.get(row.inviterId) ?? null,
      };
    });
  }

  /** Invitee ids with a live pending invitation to the club. */
  async listPendingInviteeIds(clubId: string, tx?: TransactionContext): Promise<Set<string>> {
    const rows = await this.db(tx).clubInvitation.findMany({
      where: { clubId, status: 'pending' },
      select: { inviteeMemberId: true },
    });
    return new Set(rows.map((row) => row.inviteeMemberId));
  }

  /** Mark the member's pending invitation accepted when they join via link. */
  async acceptPendingInvitationFor(
    tx: TransactionContext,
    clubId: string,
    memberId: string,
    respondedAt: Date,
  ): Promise<void> {
    await asPrismaTx(tx).clubInvitation.updateMany({
      where: { clubId, inviteeMemberId: memberId, status: 'pending' },
      data: { status: 'accepted', respondedAt },
    });
  }

  /** Withdraw (revoke) pending invitations SENT by a member; returns the rows revoked. */
  async withdrawPendingInvitationsBy(
    tx: TransactionContext,
    inviterId: string,
    respondedAt: Date,
  ): Promise<ClubInvitationRecord[]> {
    return this.withdrawPending(tx, { inviterId }, respondedAt);
  }

  /** Withdraw (revoke) pending invitations RECEIVED by a member; returns the rows revoked. */
  async withdrawPendingInvitationsTo(
    tx: TransactionContext,
    inviteeMemberId: string,
    respondedAt: Date,
  ): Promise<ClubInvitationRecord[]> {
    return this.withdrawPending(tx, { inviteeMemberId }, respondedAt);
  }

  /**
   * Find-then-revoke with a compare-and-set per row: the UPDATE re-checks
   * status = 'pending' (like transitionInvitation), so an invitation a
   * concurrent accept just claimed is skipped, never clobbered to revoked.
   * The race is real: the account-deletion seam only advisory-locks clubs
   * the member still belongs to, and a pending invite survives in a club
   * they LEFT, where respond/withdraw would otherwise not serialize. Only
   * rows actually revoked are returned, so the caller's audit trail matches
   * what happened.
   */
  private async withdrawPending(
    tx: TransactionContext,
    scope: { inviterId: string } | { inviteeMemberId: string },
    respondedAt: Date,
  ): Promise<ClubInvitationRecord[]> {
    const prisma = asPrismaTx(tx);
    const rows = await prisma.clubInvitation.findMany({
      where: { ...scope, status: 'pending' },
    });
    const revoked: ClubInvitationRecord[] = [];
    for (const row of rows) {
      const updated = await prisma.clubInvitation.updateMany({
        where: { id: row.id, status: 'pending' },
        data: { status: 'revoked', respondedAt },
      });
      if (updated.count > 0) {
        revoked.push({ ...row, status: 'revoked', respondedAt } as ClubInvitationRecord);
      }
    }
    return revoked;
  }

  // ── Invite links ──

  async createInviteLink(
    tx: TransactionContext,
    input: {
      clubId: string;
      tokenHash: string;
      createdById: string;
      expiresAt: Date | null;
      maxUses: number | null;
    },
  ): Promise<ClubInviteLinkRecord> {
    return asPrismaTx(tx).clubInviteLink.create({ data: input }) as Promise<ClubInviteLinkRecord>;
  }

  async findInviteLinkByTokenHash(tokenHash: string): Promise<ClubInviteLinkRecord | null> {
    return this.prisma.clubInviteLink.findUnique({
      where: { tokenHash },
    }) as Promise<ClubInviteLinkRecord | null>;
  }

  /** Revoke every active link of the club (rotation, deletion). Returns ids. */
  async revokeActiveInviteLinks(
    tx: TransactionContext,
    clubId: string,
    revokedAt: Date,
  ): Promise<string[]> {
    const prisma = asPrismaTx(tx);
    const rows = await prisma.clubInviteLink.findMany({
      where: { clubId, revokedAt: null },
      select: { id: true },
    });
    if (rows.length === 0) return [];
    await prisma.clubInviteLink.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { revokedAt },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Consume one use, re-checking revocation/expiry/exhaustion INSIDE the
   * update (useCount < maxUses is a column-to-column comparison Prisma
   * cannot express). 0 rows = the link died between read and consume.
   */
  async consumeInviteLinkUse(tx: TransactionContext, linkId: string, now: Date): Promise<boolean> {
    const updated = await asPrismaTx(tx).$executeRaw`
      UPDATE "club_invite_links"
      SET "useCount" = "useCount" + 1
      WHERE "id" = ${linkId}
        AND "revokedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
        AND ("maxUses" IS NULL OR "useCount" < "maxUses")
    `;
    return updated > 0;
  }

  // ── Member existence ──
  // The members BC owns that table; clubs only checks invitee existence.

  async filterExistingMemberIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const members = await this.prisma.member.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return new Set(members.map((member) => member.id));
  }
}
