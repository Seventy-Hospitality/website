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
    return this.db(tx).member.findUnique({
      where: { email },
      select: { id: true, userId: true },
    });
  }

  async claim(tx: TransactionContext, memberId: string, userId: string): Promise<void> {
    const result = await this.db(tx).member.updateMany({
      where: { id: memberId, userId: null },
      data: { userId },
    });
    if (result.count !== 1) {
      throw new Error(`Member ${memberId} was claimed concurrently`);
    }
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
