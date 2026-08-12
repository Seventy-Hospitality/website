import type { PrismaClient } from '@prisma/client';
import type { BillingTransaction, LedgerEntryDraft, LedgerRowForTotals } from '../domain';

export class TransactionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The one write path: converge on [stripeObjectType, stripeObjectId].
   * Webhook, refund adapter and reconcile sweep all land here; a lost
   * create race retries as an update, so concurrent writers are safe.
   */
  async upsertByStripeObject(draft: LedgerEntryDraft): Promise<void> {
    const update = {
      status: draft.status,
      amountCents: draft.amountCents,
      taxCents: draft.taxCents,
      occurredAt: draft.occurredAt,
      receiptUrl: draft.receiptUrl,
      stripeChargeId: draft.stripeChargeId,
      // Domain linkage can only improve (a reconcile pass may know more
      // than the original webhook did); never null it back out.
      ...(draft.reservationId ? { reservationId: draft.reservationId } : {}),
      ...(draft.membershipId ? { membershipId: draft.membershipId } : {}),
      ...(draft.stripeEventId ? { stripeEventId: draft.stripeEventId } : {}),
    };
    try {
      await this.prisma.billingTransaction.upsert({
        where: {
          stripeObjectType_stripeObjectId: {
            stripeObjectType: draft.stripeObjectType,
            stripeObjectId: draft.stripeObjectId,
          },
        },
        create: { ...draft },
        update,
      });
    } catch (err: any) {
      // Upsert is not atomic against a concurrent insert; a lost race is a
      // plain update.
      if (err?.code !== 'P2002') throw err;
      await this.prisma.billingTransaction.updateMany({
        where: {
          stripeObjectType: draft.stripeObjectType,
          stripeObjectId: draft.stripeObjectId,
        },
        data: update,
      });
    }
  }

  /** Every row that matters for month buckets (small per member). */
  async listRowsForTotals(memberId: string): Promise<LedgerRowForTotals[]> {
    return this.prisma.billingTransaction.findMany({
      where: { memberId },
      select: { direction: true, amountCents: true, status: true, occurredAt: true },
      orderBy: { occurredAt: 'desc' },
    }) as unknown as LedgerRowForTotals[];
  }

  async listForMemberBetween(memberId: string, from: Date, to: Date): Promise<BillingTransaction[]> {
    return this.prisma.billingTransaction.findMany({
      where: { memberId, occurredAt: { gte: from, lt: to } },
      orderBy: { occurredAt: 'desc' },
    }) as unknown as BillingTransaction[];
  }

  /** Money still in flight (account-closure blocker). */
  async countPendingForMember(memberId: string): Promise<number> {
    return this.prisma.billingTransaction.count({
      where: { memberId, status: 'pending' },
    });
  }
}
