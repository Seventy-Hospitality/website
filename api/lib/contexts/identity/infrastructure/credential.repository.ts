import type { PrismaClient } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';

const PASSWORD = 'password';

export class CredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private client(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async findPassword(userId: string, tx?: TransactionContext): Promise<{ secretHash: string } | null> {
    return this.client(tx).userCredential.findUnique({
      where: { userId_type: { userId, type: PASSWORD } },
      select: { secretHash: true },
    });
  }

  async upsertPassword(userId: string, secretHash: string, tx?: TransactionContext): Promise<void> {
    await this.client(tx).userCredential.upsert({
      where: { userId_type: { userId, type: PASSWORD } },
      update: { secretHash },
      create: { userId, type: PASSWORD, secretHash },
    });
  }

  async deletePassword(userId: string, tx?: TransactionContext): Promise<void> {
    await this.client(tx).userCredential.deleteMany({ where: { userId, type: PASSWORD } });
  }
}
