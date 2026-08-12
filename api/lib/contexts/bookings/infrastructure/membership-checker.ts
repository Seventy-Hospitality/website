import type { PrismaClient } from '@prisma/client';
import { isEntitledStatus, pickCurrentMembership } from '@/lib/contexts/memberships/domain';
import type { MemberTier, MembershipChecker } from '../domain';

export class PrismaMembershipChecker implements MembershipChecker {
  constructor(private readonly prisma: PrismaClient) {}

  async hasActiveMembership(memberId: string): Promise<boolean> {
    const current = await this.currentMembership(memberId);
    return current !== null && isEntitledStatus(current.status);
  }

  async getTier(memberId: string): Promise<MemberTier | null> {
    const current = await this.currentMembership(memberId);
    if (!current || !isEntitledStatus(current.status)) return null;
    return current.plan.tier === 'pro' ? 'pro' : 'member';
  }

  /**
   * memberships is one row per Stripe subscription; the entitlement check
   * reads the member's CURRENT row (shared pick logic in the memberships
   * domain).
   */
  private async currentMembership(memberId: string) {
    const rows = await this.prisma.membership.findMany({
      where: { memberId },
      select: { status: true, currentPeriodEnd: true, plan: { select: { tier: true } } },
    });
    return pickCurrentMembership(rows);
  }
}
