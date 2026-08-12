import { Prisma, type PrismaClient } from '@prisma/client';
import type { TransactionContext } from '@/lib/kernel';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';

export interface SeriesRecord {
  id: string;
  organizerId: string;
  resourceTypeId: string;
  weekday: number;
  startTimeLocal: string;
  durationMinutes: number;
  active: boolean;
  createdByAdminId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeriesAdminRecord extends SeriesRecord {
  resourceType: { id: string; code: string; name: string };
  organizer: { id: string; firstName: string; lastName: string; memberNumber: string };
}

export interface CreateSeriesRecordInput {
  organizerId: string;
  resourceTypeId: string;
  weekday: number;
  startTimeLocal: string;
  durationMinutes: number;
  createdByAdminId: string;
}

const adminInclude = {
  resourceType: { select: { id: true, code: true, name: true } },
  organizer: { select: { id: true, firstName: true, lastName: true, memberNumber: true } },
} as const;

export class ReservationSeriesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateSeriesRecordInput): Promise<SeriesAdminRecord> {
    return this.prisma.reservationSeries.create({
      data: input,
      include: adminInclude,
    }) as Promise<SeriesAdminRecord>;
  }

  async getById(id: string): Promise<SeriesRecord | null> {
    return this.prisma.reservationSeries.findUnique({ where: { id } }) as Promise<SeriesRecord | null>;
  }

  async list(): Promise<SeriesAdminRecord[]> {
    return this.prisma.reservationSeries.findMany({
      include: adminInclude,
      orderBy: { createdAt: 'desc' },
    }) as Promise<SeriesAdminRecord[]>;
  }

  async listActive(): Promise<SeriesRecord[]> {
    return this.prisma.reservationSeries.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    }) as Promise<SeriesRecord[]>;
  }

  /** CAS deactivation: false means it was already inactive (idempotent). */
  async deactivate(id: string): Promise<boolean> {
    const result = await this.prisma.reservationSeries.updateMany({
      where: { id, active: true },
      data: { active: false },
    });
    return result.count > 0;
  }

  /** Any reservation (whatever status) already materialized for this date. */
  async occurrenceExists(seriesId: string, localDate: string): Promise<boolean> {
    const count = await this.prisma.reservation.count({ where: { seriesId, localDate } });
    return count > 0;
  }

  async hasSkip(seriesId: string, localDate: string): Promise<boolean> {
    const count = await this.prisma.reservationSeriesSkip.count({ where: { seriesId, localDate } });
    return count > 0;
  }

  /**
   * Record a skipped occurrence; false when it was already recorded (the
   * unique key makes skip-and-notify exactly-once). Runs in the caller's
   * transaction so the marker and its outbox event commit atomically.
   */
  async tryRecordSkip(
    tx: TransactionContext,
    seriesId: string,
    localDate: string,
    reason: string,
  ): Promise<boolean> {
    const prisma = asPrismaTx(tx);
    try {
      await prisma.reservationSeriesSkip.create({ data: { seriesId, localDate, reason } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  /** Future materialized occurrences still alive (for series cancellation). */
  async listFutureActiveOccurrences(
    seriesId: string,
    now: Date,
  ): Promise<Array<{ id: string; startsAt: Date; status: string }>> {
    return this.prisma.reservation.findMany({
      where: { seriesId, startsAt: { gt: now }, status: { in: ['pending_payment', 'confirmed'] } },
      select: { id: true, startsAt: true, status: true },
      orderBy: { startsAt: 'asc' },
    });
  }
}
