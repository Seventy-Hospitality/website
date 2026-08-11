import { Prisma, type PrismaClient } from '@prisma/client';

export type LedgerClaim = 'claimed' | 'already_sent';

/**
 * The delivered-notifications ledger: the idempotency guard the outbox
 * consumer claims BEFORE sending on a channel.
 *
 * Deliberately NOT transactional with the dispatcher's outbox pass: a
 * "sent" mark must survive the dispatch transaction rolling back (that is
 * its whole purpose: a batch that fails halfway is retried, and the marks
 * are what stop the already-delivered notifications from being sent
 * twice). Every write here auto-commits on the plain client.
 *
 * Claim semantics: the first claim inserts a pending row; a re-claim of a
 * pending row (previous attempt failed or crashed) succeeds and bumps
 * attempts; a claim of a sent row refuses. The unique key arbitrates
 * concurrent claimers.
 */
export class DeliveredNotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(eventSeq: number, recipient: string, channel: string): Promise<LedgerClaim> {
    try {
      await this.prisma.deliveredNotification.create({
        data: { eventSeq, recipient, channel },
      });
      return 'claimed';
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }

    // Row exists: re-claim only if the previous attempt never reached sent.
    const reclaimed = await this.prisma.deliveredNotification.updateMany({
      where: { eventSeq, recipient, channel, status: 'pending' },
      data: { attempts: { increment: 1 } },
    });
    return reclaimed.count > 0 ? 'claimed' : 'already_sent';
  }

  async markSent(eventSeq: number, recipient: string, channel: string): Promise<void> {
    await this.prisma.deliveredNotification.updateMany({
      where: { eventSeq, recipient, channel },
      data: { status: 'sent', sentAt: new Date(), lastError: null },
    });
  }

  async recordFailure(eventSeq: number, recipient: string, channel: string, message: string): Promise<void> {
    await this.prisma.deliveredNotification.updateMany({
      where: { eventSeq, recipient, channel, status: 'pending' },
      data: { lastError: message.slice(0, 500) },
    });
  }
}
