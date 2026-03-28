import type { PrismaClient } from '@prisma/client';
import type { Shower } from '../domain';

export class ShowerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listActive(): Promise<Shower[]> {
    return this.prisma.shower.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    }) as unknown as Shower[];
  }

  async getById(id: string): Promise<Shower | null> {
    return this.prisma.shower.findUnique({ where: { id } }) as unknown as Shower | null;
  }
}
