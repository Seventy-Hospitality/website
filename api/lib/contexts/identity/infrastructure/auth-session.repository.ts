import type { PrismaClient } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import type { Client } from '../domain';

export interface AuthSessionRecord {
  id: string;
  userId: string;
  client: string;
  refreshTokenHash: string;
  previousTokenHash: string | null;
  rotatedAt: Date | null;
  issuedAt: Date;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  deviceName: string | null;
  ip: string | null;
}

export class AuthSessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private db(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async create(
    input: {
      userId: string;
      client: Client;
      refreshTokenHash: string;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
      deviceName?: string | null;
      ip?: string | null;
    },
    tx?: TransactionContext,
  ): Promise<AuthSessionRecord> {
    return this.db(tx).authSession.create({ data: input });
  }

  async findById(id: string): Promise<AuthSessionRecord | null> {
    return this.prisma.authSession.findUnique({ where: { id } });
  }

  async findByRefreshTokenHash(hash: string): Promise<AuthSessionRecord | null> {
    return this.prisma.authSession.findUnique({ where: { refreshTokenHash: hash } });
  }

  async findByPreviousTokenHash(hash: string): Promise<AuthSessionRecord | null> {
    return this.prisma.authSession.findFirst({ where: { previousTokenHash: hash } });
  }

  /**
   * Guarded rotation: only applies when the current refreshTokenHash still is
   * `expectedCurrentHash`, so two concurrent rotations cannot both win.
   * Returns false when the guard misses.
   */
  async rotate(
    id: string,
    update: {
      expectedCurrentHash: string;
      refreshTokenHash: string;
      previousTokenHash: string | null;
      rotatedAt: Date;
      idleExpiresAt: Date;
      lastUsedAt: Date;
    },
  ): Promise<boolean> {
    const { expectedCurrentHash, ...data } = update;
    const result = await this.prisma.authSession.updateMany({
      where: { id, refreshTokenHash: expectedCurrentHash, revokedAt: null },
      data,
    });
    return result.count === 1;
  }

  /** Non-critical activity stamp; callers fire and forget. */
  async touch(id: string): Promise<void> {
    await this.prisma.authSession
      .update({ where: { id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  async revoke(id: string, reason: string, tx?: TransactionContext): Promise<void> {
    await this.db(tx).authSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    options?: { exceptSessionId?: string },
    tx?: TransactionContext,
  ): Promise<number> {
    const result = await this.db(tx).authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options?.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  /** Revokes the oldest active sessions of (userId, client) beyond keepCount. */
  async evictBeyondCap(
    userId: string,
    client: Client,
    keepCount: number,
    tx?: TransactionContext,
  ): Promise<void> {
    const db = this.db(tx);
    const now = new Date();
    const stale = await db.authSession.findMany({
      where: {
        userId,
        client,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      orderBy: { lastUsedAt: 'desc' },
      skip: keepCount,
      select: { id: true },
    });

    if (stale.length > 0) {
      await db.authSession.updateMany({
        where: { id: { in: stale.map((s) => s.id) } },
        data: { revokedAt: now, revokedReason: 'evicted' },
      });
    }
  }
}
