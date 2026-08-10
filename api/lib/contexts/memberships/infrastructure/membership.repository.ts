import type { PrismaClient } from '@prisma/client';
import { pickCurrentMembership, type Membership } from '../domain';

export interface SnapshotApplyData {
  subscriptionId: string;
  memberId: string;
  planId: string;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  scheduleId: string | null;
  fetchedAt: Date;
}

export type SnapshotApplyOutcome = 'created' | 'updated' | 'stale';

export class MembershipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * "The member's current membership": memberId is not unique (one row per
   * Stripe subscription), so this picks the operative row by status rank +
   * latest period end. A member has a handful of rows over a lifetime.
   */
  async getCurrentForMember(memberId: string): Promise<Membership | null> {
    const rows = (await this.prisma.membership.findMany({
      where: { memberId },
    })) as unknown as Membership[];
    return pickCurrentMembership(rows);
  }

  async getByStripeSubscriptionId(subscriptionId: string): Promise<Membership | null> {
    return this.prisma.membership.findUnique({
      where: { stripeSubscriptionId: subscriptionId },
    }) as unknown as Membership | null;
  }

  /**
   * The ONE write path for webhook/read-back/drift subscription state: a
   * pure upsert by stripeSubscriptionId guarded two ways.
   *
   * - Fetch-time ordering: a snapshot fetched earlier never overwrites one
   *   fetched later, whatever field moved (period ends can legitimately
   *   move backwards on interval changes, so guarding on them is wrong).
   * - No exit from `canceled`: Stripe never reactivates a canceled
   *   subscription, so only a STALE pre-cancel snapshot could ever move a
   *   row out of that status. Blocked unless the incoming status is itself
   *   `canceled`.
   *
   * A guarded update matching zero rows is reported as 'stale' (never
   * silently swallowed); a lost create race retries as an update.
   */
  async applySnapshot(data: SnapshotApplyData): Promise<SnapshotApplyOutcome> {
    const attemptUpdate = async (): Promise<boolean> => {
      const updated = await this.prisma.membership.updateMany({
        where: {
          stripeSubscriptionId: data.subscriptionId,
          OR: [{ stripeFetchedAt: null }, { stripeFetchedAt: { lte: data.fetchedAt } }],
          ...(data.status !== 'canceled' ? { status: { not: 'canceled' } } : {}),
        },
        data: {
          memberId: data.memberId,
          planId: data.planId,
          status: data.status,
          currentPeriodEnd: data.currentPeriodEnd,
          cancelAtPeriodEnd: data.cancelAtPeriodEnd,
          stripeScheduleId: data.scheduleId,
          // A detached schedule (released/completed) clears the pending
          // downgrade; while attached, the pending fields set by changePlan
          // stay authoritative.
          ...(data.scheduleId === null ? { pendingPlanId: null, pendingPlanEffectiveAt: null } : {}),
          stripeFetchedAt: data.fetchedAt,
        },
      });
      return updated.count > 0;
    };

    if (await attemptUpdate()) return 'updated';

    const existing = await this.prisma.membership.findUnique({
      where: { stripeSubscriptionId: data.subscriptionId },
      select: { id: true },
    });
    if (existing) return 'stale';

    try {
      await this.prisma.membership.create({
        data: {
          stripeSubscriptionId: data.subscriptionId,
          memberId: data.memberId,
          planId: data.planId,
          status: data.status,
          currentPeriodEnd: data.currentPeriodEnd,
          cancelAtPeriodEnd: data.cancelAtPeriodEnd,
          stripeScheduleId: data.scheduleId,
          stripeFetchedAt: data.fetchedAt,
        },
      });
      return 'created';
    } catch (err: any) {
      // Lost the create race (unique stripeSubscriptionId): retry guarded.
      if (err?.code !== 'P2002') throw err;
      return (await attemptUpdate()) ? 'updated' : 'stale';
    }
  }

  /** Pending downgrade bookkeeping (set by changePlan, cleared on release). */
  async setPendingDowngrade(
    subscriptionId: string,
    pending: { scheduleId: string; pendingPlanId: string; effectiveAt: Date },
  ): Promise<void> {
    await this.prisma.membership.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: {
        stripeScheduleId: pending.scheduleId,
        pendingPlanId: pending.pendingPlanId,
        pendingPlanEffectiveAt: pending.effectiveAt,
      },
    });
  }

  async clearPendingDowngrade(subscriptionId: string): Promise<void> {
    await this.prisma.membership.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: { stripeScheduleId: null, pendingPlanId: null, pendingPlanEffectiveAt: null },
    });
  }

  /**
   * Force a terminal status when Stripe no longer knows the subscription id
   * at all (resource_missing). Reported, never silent.
   */
  async markCanceledBySubscriptionId(subscriptionId: string, fetchedAt: Date): Promise<boolean> {
    const updated = await this.prisma.membership.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: { status: 'canceled', stripeFetchedAt: fetchedAt },
    });
    return updated.count > 0;
  }

  /** Every row with its subscription id (drift sweep bookkeeping). */
  async listAll(): Promise<Array<Pick<Membership, 'id' | 'memberId' | 'stripeSubscriptionId' | 'status'>>> {
    return this.prisma.membership.findMany({
      select: { id: true, memberId: true, stripeSubscriptionId: true, status: true },
    }) as unknown as Array<Pick<Membership, 'id' | 'memberId' | 'stripeSubscriptionId' | 'status'>>;
  }
}
