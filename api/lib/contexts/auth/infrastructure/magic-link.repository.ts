import type { PrismaClient } from '@prisma/client';
import type { MagicLinkToken } from '../domain';

export class MagicLinkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(email: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.prisma.magicLinkToken.create({
      data: { email, tokenHash, expiresAt },
    });
  }

  async findByHash(tokenHash: string): Promise<MagicLinkToken | null> {
    return this.prisma.magicLinkToken.findUnique({
      where: { tokenHash },
    }) as unknown as MagicLinkToken | null;
  }

  async markUsed(id: string): Promise<void> {
    await this.prisma.magicLinkToken.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }
}
