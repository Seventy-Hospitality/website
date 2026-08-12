import type { PrismaClient } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import type { OneTimeTokenPurpose } from '../domain';

export class AuthTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private db(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async create(
    input: {
      purpose: OneTimeTokenPurpose;
      identifier: string;
      tokenHash: string;
      expiresAt: Date;
      bindingHash?: string | null;
    },
    tx?: TransactionContext,
  ): Promise<void> {
    await this.db(tx).authToken.create({ data: input });
  }

  /**
   * Atomically consumes an unconsumed, unexpired token. Returns its
   * identifier, or null when nothing was consumed (unknown, used or expired).
   */
  async consume(
    purpose: OneTimeTokenPurpose,
    tokenHash: string,
    tx?: TransactionContext,
  ): Promise<{ identifier: string; bindingHash: string | null } | null> {
    const db = this.db(tx);
    const result = await db.authToken.updateMany({
      where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (result.count !== 1) return null;

    const row = await db.authToken.findUnique({
      where: { tokenHash },
      select: { identifier: true, bindingHash: true },
    });
    return row;
  }

  /** Consumes all outstanding tokens of a purpose for an identifier. */
  async invalidateAll(
    purpose: OneTimeTokenPurpose,
    identifier: string,
    tx?: TransactionContext,
  ): Promise<void> {
    await this.db(tx).authToken.updateMany({
      where: { purpose, identifier, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }
}
