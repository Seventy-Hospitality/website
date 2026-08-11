import type { PrismaClient } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import type { IdVerificationStatus } from '../domain';

export interface IdVerificationRecord {
  id: string;
  memberId: string;
  status: IdVerificationStatus;
  imageAssetRef: string | null;
  skippedAt: Date | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedByAdminId: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdVerificationQueueRow extends IdVerificationRecord {
  member: {
    id: string;
    memberNumber: string;
    firstName: string;
    lastName: string;
    displayName: string | null;
    avatarUrl: string | null;
    email: string;
  };
}

const MEMBER_SELECT = {
  id: true,
  memberNumber: true,
  firstName: true,
  lastName: true,
  displayName: true,
  avatarUrl: true,
  email: true,
} as const;

export class IdVerificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private client(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async getByMemberId(memberId: string, tx?: TransactionContext): Promise<IdVerificationRecord | null> {
    return this.client(tx).idVerification.findUnique({ where: { memberId } }) as Promise<IdVerificationRecord | null>;
  }

  /** Creates the not_submitted row on first touch. */
  async getOrCreate(memberId: string, tx?: TransactionContext): Promise<IdVerificationRecord> {
    return this.client(tx).idVerification.upsert({
      where: { memberId },
      create: { memberId },
      update: {},
    }) as Promise<IdVerificationRecord>;
  }

  async setPhoto(memberId: string, imageAssetRef: string, tx?: TransactionContext): Promise<void> {
    await this.client(tx).idVerification.update({ where: { memberId }, data: { imageAssetRef } });
  }

  async recordSkip(memberId: string, when: Date, tx?: TransactionContext): Promise<void> {
    await this.client(tx).idVerification.upsert({
      where: { memberId },
      create: { memberId, skippedAt: when },
      update: { skippedAt: when },
    });
  }

  /**
   * Compare-and-set submit: only a row still in an uploadable state with a
   * photo moves to submitted. 0 rows = lost a race.
   */
  async transitionToSubmitted(memberId: string, when: Date, tx?: TransactionContext): Promise<boolean> {
    const result = await this.client(tx).idVerification.updateMany({
      where: { memberId, status: { in: ['not_submitted', 'rejected'] }, imageAssetRef: { not: null } },
      data: { status: 'submitted', submittedAt: when, reviewedAt: null, reviewedByAdminId: null, note: null },
    });
    return result.count === 1;
  }

  /**
   * Compare-and-set review: only a submitted row can be decided, so two
   * staff racing on one submission produce exactly one decision. The
   * photo pointer is nulled in the same write (short retention); the
   * caller deletes the object after commit.
   */
  async applyReview(
    memberId: string,
    outcome: { status: IdVerificationStatus; reviewedByAdminId: string; note: string | null; when: Date },
    tx?: TransactionContext,
  ): Promise<boolean> {
    const result = await this.client(tx).idVerification.updateMany({
      where: { memberId, status: 'submitted' },
      data: {
        status: outcome.status,
        reviewedAt: outcome.when,
        reviewedByAdminId: outcome.reviewedByAdminId,
        note: outcome.note,
        imageAssetRef: null,
      },
    });
    return result.count === 1;
  }

  async listByStatus(status: IdVerificationStatus, limit = 100): Promise<IdVerificationQueueRow[]> {
    return this.prisma.idVerification.findMany({
      where: { status },
      include: { member: { select: MEMBER_SELECT } },
      orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    }) as Promise<IdVerificationQueueRow[]>;
  }

  async deleteForMember(memberId: string, tx?: TransactionContext): Promise<void> {
    await this.client(tx).idVerification.deleteMany({ where: { memberId } });
  }
}
