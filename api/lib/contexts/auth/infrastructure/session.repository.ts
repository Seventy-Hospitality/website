import type { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import type { Session } from '../domain';

export class SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(email: string, expiresAt: Date): Promise<Session> {
    const userId = await this.getOrCreateUserId(email);

    return this.prisma.session.create({
      data: {
        id: createId(),
        userId,
        email,
        expiresAt,
        lastActiveAt: new Date(),
      },
    }) as unknown as Session;
  }

  async findById(id: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id } }) as unknown as Session | null;
  }

  async updateLastActive(id: string): Promise<void> {
    await this.prisma.session.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    }).catch(() => {}); // Non-critical
  }

  async delete(id: string): Promise<void> {
    await this.prisma.session.delete({ where: { id } }).catch(() => {});
  }

  async evictOldest(email: string, keepCount: number): Promise<void> {
    const sessions = await this.prisma.session.findMany({
      where: { email },
      orderBy: { lastActiveAt: 'desc' },
      skip: keepCount,
      select: { id: true },
    });

    if (sessions.length > 0) {
      await this.prisma.session.deleteMany({
        where: { id: { in: sessions.map((s) => s.id) } },
      });
    }
  }

  private async getOrCreateUserId(email: string): Promise<string> {
    // For MVP, userId = a stable hash of email. In a full system this would
    // be a User table lookup/create.
    const existing = await this.prisma.session.findFirst({
      where: { email },
      select: { userId: true },
      orderBy: { createdAt: 'desc' },
    });

    return existing?.userId ?? createId();
  }
}
