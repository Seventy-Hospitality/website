import type { PrismaClient } from '@prisma/client';
import type { MembershipChecker } from '../domain';

export class PrismaMembershipChecker implements MembershipChecker {
  constructor(private readonly prisma: PrismaClient) {}

  async hasActiveMembership(memberId: string): Promise<boolean> {
    const membership = await this.prisma.membership.findUnique({
      where: { memberId },
      select: { status: true },
    });
    return membership?.status === 'active';
  }
}
