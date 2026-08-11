import { Prisma, type PrismaClient } from '@prisma/client';
import type { LedgerClaim } from './delivered-notification.repository';

/**
 * Reminder-sent markers: at most one booking reminder per
 * (reservation, member), with the same claim semantics as the
 * delivered-notifications ledger (claim before send; a claim that never
 * reached "sent" is retried by the next cron pass; "sent" refuses forever).
 * Auto-commits on the plain client for the same reason: a mark must
 * survive whatever transaction the caller is in.
 */
export class BookingReminderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(reservationId: string, memberId: string): Promise<LedgerClaim> {
    try {
      await this.prisma.bookingReminder.create({ data: { reservationId, memberId } });
      return 'claimed';
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }

    const reclaimed = await this.prisma.bookingReminder.updateMany({
      where: { reservationId, memberId, status: 'pending' },
      data: { attempts: { increment: 1 } },
    });
    return reclaimed.count > 0 ? 'claimed' : 'already_sent';
  }

  async markSent(reservationId: string, memberId: string): Promise<void> {
    await this.prisma.bookingReminder.updateMany({
      where: { reservationId, memberId },
      data: { status: 'sent', sentAt: new Date(), lastError: null },
    });
  }

  async recordFailure(reservationId: string, memberId: string, message: string): Promise<void> {
    await this.prisma.bookingReminder.updateMany({
      where: { reservationId, memberId, status: 'pending' },
      data: { lastError: message.slice(0, 500) },
    });
  }
}
