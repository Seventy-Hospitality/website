import type { PrismaClient } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import { generateMemberNumber } from '@/lib/contexts/members';
import type { MemberDirectory } from '../application/ports';

/**
 * Stage-1 adapter over the members table for signup-time profile creation and
 * verified-email claiming. The members BC owns this table; this adapter is
 * the only identity-side code touching it, so later packages can replace it
 * with a members-context API without touching the services.
 */
export class PrismaMemberDirectory implements MemberDirectory {
  constructor(private readonly prisma: PrismaClient) {}

  private db(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async findByEmail(tx: TransactionContext, email: string) {
    const member = await this.db(tx).member.findUnique({
      where: { email },
      select: { id: true, userId: true, stripeCustomerId: true, memberships: { select: { id: true }, take: 1 } },
    });
    if (!member) return null;
    return {
      id: member.id,
      userId: member.userId,
      // A Stripe customer or a membership row makes this a high-value claim
      // target (billing portal, subscription); the claim policy requires
      // proven account control before handing such a row over.
      hasBilling: member.stripeCustomerId !== null || member.memberships.length > 0,
    };
  }

  async claim(tx: TransactionContext, memberId: string, userId: string): Promise<boolean> {
    const result = await this.db(tx).member.updateMany({
      where: { id: memberId, userId: null },
      data: { userId },
    });
    // count === 0 means another verification/sign-in claimed the row microseconds
    // earlier — a benign race, not a failure. Report it so the caller skips the
    // audit event rather than aborting the whole transaction with a 500.
    return result.count === 1;
  }

  async createForUser(
    tx: TransactionContext,
    input: { userId: string; email: string; firstName: string; lastName: string; phone?: string },
  ): Promise<{ id: string }> {
    const member = await this.db(tx).member.create({
      data: {
        userId: input.userId,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone ?? null,
        memberNumber: await this.pickFreeMemberNumber(tx),
      },
      select: { id: true },
    });
    return member;
  }

  /**
   * A unique-violation retry loop would abort the caller's transaction, so
   * candidates are pre-checked instead. The space is one letter x 100000, a
   * simultaneous identical pick is astronomically unlikely; if it ever
   * happens the transaction fails and the signup is retried.
   */
  private async pickFreeMemberNumber(tx: TransactionContext): Promise<string> {
    let candidate = generateMemberNumber();
    for (let attempt = 0; attempt < 8; attempt++) {
      const taken = await this.db(tx).member.findUnique({
        where: { memberNumber: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
      candidate = generateMemberNumber();
    }
    return candidate;
  }
}
