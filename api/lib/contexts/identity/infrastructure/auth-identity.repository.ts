import type { PrismaClient } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import type { Provider } from '../domain';

export interface AuthIdentityRecord {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateRelay: boolean;
  refreshTokenEnc: string | null;
  linkedAt: Date;
  lastUsedAt: Date | null;
}

export class AuthIdentityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private client(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async findByProviderSubject(
    provider: Provider,
    subject: string,
    tx?: TransactionContext,
  ): Promise<AuthIdentityRecord | null> {
    return this.client(tx).authIdentity.findUnique({
      where: { provider_subject: { provider, subject } },
    });
  }

  async create(
    input: {
      userId: string;
      provider: Provider;
      subject: string;
      email: string | null;
      emailVerified: boolean;
      isPrivateRelay: boolean;
      refreshTokenEnc?: string | null;
    },
    tx?: TransactionContext,
  ): Promise<AuthIdentityRecord> {
    return this.client(tx).authIdentity.create({
      data: { ...input, lastUsedAt: new Date() },
    });
  }

  async touchUsed(
    id: string,
    updates: { email?: string | null; emailVerified?: boolean; isPrivateRelay?: boolean },
    tx?: TransactionContext,
  ): Promise<void> {
    await this.client(tx).authIdentity.update({
      where: { id },
      data: { ...updates, lastUsedAt: new Date() },
    });
  }

  async setRefreshToken(id: string, refreshTokenEnc: string, tx?: TransactionContext): Promise<void> {
    await this.client(tx).authIdentity.update({ where: { id }, data: { refreshTokenEnc } });
  }

  async listByUser(userId: string, tx?: TransactionContext): Promise<AuthIdentityRecord[]> {
    return this.client(tx).authIdentity.findMany({ where: { userId }, orderBy: { linkedAt: 'asc' } });
  }

  async deleteForUser(userId: string, provider: Provider, tx?: TransactionContext): Promise<void> {
    await this.client(tx).authIdentity.deleteMany({ where: { userId, provider } });
  }

  /** Removes every provider identity for a user (pre-hijack credential purge). */
  async deleteAllForUser(userId: string, tx?: TransactionContext): Promise<void> {
    await this.client(tx).authIdentity.deleteMany({ where: { userId } });
  }
}
