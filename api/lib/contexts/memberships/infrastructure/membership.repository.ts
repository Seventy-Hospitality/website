import type { PrismaClient } from '@prisma/client';
import type { Membership } from '../domain';

export class MembershipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getByMemberId(memberId: string): Promise<Membership | null> {
    return this.prisma.membership.findUnique({
      where: { memberId },
    }) as unknown as Membership | null;
  }

  async upsertBySubscriptionId(subscriptionId: string, data: {
    memberId: string;
    planId: string;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  }): Promise<Membership> {
    return this.prisma.membership.upsert({
      where: { stripeSubscriptionId: subscriptionId },
      create: { stripeSubscriptionId: subscriptionId, ...data },
      update: {
        status: data.status,
        currentPeriodEnd: data.currentPeriodEnd,
        cancelAtPeriodEnd: data.cancelAtPeriodEnd,
        planId: data.planId,
      },
    }) as unknown as Membership;
  }

  async updateBySubscriptionId(subscriptionId: string, data: Record<string, unknown>): Promise<void> {
    await this.prisma.membership.update({
      where: { stripeSubscriptionId: subscriptionId },
      data,
    }).catch((err: any) => {
      // Ignore if subscription not found (webhook for unknown subscription)
      if (err?.code === 'P2025') return;
      throw err;
    });
  }

  async updateManyBySubscriptionId(subscriptionId: string, data: Record<string, unknown>): Promise<void> {
    await this.prisma.membership.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data,
    });
  }
}
