import type { PrismaClient } from '@prisma/client';
import type { MemberTier, MembershipChecker } from '../domain';

export class PrismaMembershipChecker implements MembershipChecker {
  constructor(private readonly prisma: PrismaClient) {}

  async hasActiveMembership(memberId: string): Promise<boolean> {
    const membership = await this.prisma.membership.findUnique({
      where: { memberId },
      select: { status: true },
    });
    return membership?.status === 'active';
  }

  async getTier(memberId: string): Promise<MemberTier | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { memberId },
      select: { status: true, plan: { select: { tier: true } } },
    });
    if (membership?.status !== 'active') return null;
    return membership.plan.tier === 'pro' ? 'pro' : 'member';
  }
}
