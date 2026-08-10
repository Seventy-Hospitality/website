import type { PrismaClient } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';
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
      select: { id: true, userId: true, stripeCustomerId: true, membership: { select: { id: true } } },
    });
    if (!member) return null;
    return {
      id: member.id,
      userId: member.userId,
      // A Stripe customer or a membership row makes this a high-value claim
      // target (billing portal, subscription); the claim policy requires
      // proven account control before handing such a row over.
      hasBilling: member.stripeCustomerId !== null || member.membership !== null,
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
      },
      select: { id: true },
    });
    return member;
  }
}
