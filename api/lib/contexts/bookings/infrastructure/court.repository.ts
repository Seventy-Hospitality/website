import type { PrismaClient } from '@prisma/client';
import type { Court } from '../domain';

export class CourtRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listActive(): Promise<Court[]> {
    return this.prisma.court.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    }) as unknown as Court[];
  }

  async getById(id: string): Promise<Court | null> {
    return this.prisma.court.findUnique({ where: { id } }) as unknown as Court | null;
  }
}
