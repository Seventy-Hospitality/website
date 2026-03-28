import type { PrismaClient } from '@prisma/client';
import type { Plan } from '../domain';

export class PlanRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(activeOnly = true): Promise<Plan[]> {
    return this.prisma.membershipPlan.findMany({
      where: activeOnly ? { active: true } : undefined,
      orderBy: { amountCents: 'asc' },
    }) as unknown as Plan[];
  }

  async getById(id: string): Promise<Plan | null> {
    return this.prisma.membershipPlan.findUnique({ where: { id } }) as unknown as Plan | null;
  }

  async getByStripePriceId(stripePriceId: string): Promise<Plan | null> {
    return this.prisma.membershipPlan.findUnique({ where: { stripePriceId } }) as unknown as Plan | null;
  }
}
