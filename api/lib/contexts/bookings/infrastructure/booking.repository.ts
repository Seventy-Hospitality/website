import type { PrismaClient } from '@prisma/client';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { Booking, FacilityType, TimeSlot } from '../domain';

export class BookingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Get confirmed bookings for a facility on a date (within a transaction for concurrency) */
  async getConfirmedForFacility(
    tx: TransactionContext,
    facilityType: FacilityType,
    facilityId: string,
    date: Date,
  ): Promise<TimeSlot[]> {
    const prisma = asPrismaTx(tx);
    const bookings = await prisma.booking.findMany({
      where: { facilityType, facilityId, date, status: 'confirmed' },
      select: { startTime: true, endTime: true },
    });
    return bookings;
  }

  /** Count a member's confirmed bookings for a facility type on a date */
  async countMemberBookings(
    tx: TransactionContext,
    memberId: string,
    date: Date,
    facilityType: FacilityType,
  ): Promise<number> {
    const prisma = asPrismaTx(tx);
    return prisma.booking.count({
      where: { memberId, date, facilityType, status: 'confirmed' },
    });
  }

  /** Create a booking (within a transaction) */
  async create(
    tx: TransactionContext,
    data: {
      facilityType: FacilityType;
      facilityId: string;
      memberId: string;
      date: Date;
      startTime: string;
      endTime: string;
    },
  ): Promise<Booking> {
    const prisma = asPrismaTx(tx);
    return prisma.booking.create({ data }) as unknown as Booking;
  }

  /** Get confirmed bookings for a facility on a date (non-transactional, for availability queries) */
  async getUpcomingForFacility(
    facilityType: FacilityType,
    facilityId: string,
    date: Date,
  ): Promise<TimeSlot[]> {
    const bookings = await this.prisma.booking.findMany({
      where: { facilityType, facilityId, date, status: 'confirmed' },
      select: { startTime: true, endTime: true },
    });
    return bookings;
  }

  /** List all bookings, optionally filtered by date (admin view) */
  async listAll(date?: Date): Promise<Booking[]> {
    return this.prisma.booking.findMany({
      where: {
        status: 'confirmed',
        ...(date ? { date } : {}),
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      include: { member: { select: { id: true, firstName: true, lastName: true, email: true } } },
    }) as unknown as Booking[];
  }

  /** Get a booking by ID */
  async getById(id: string): Promise<Booking | null> {
    return this.prisma.booking.findUnique({ where: { id } }) as unknown as Booking | null;
  }

  /** Cancel a booking */
  async cancel(id: string): Promise<void> {
    await this.prisma.booking.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }

  /** Get a member's upcoming confirmed bookings */
  async getUpcomingForMember(memberId: string): Promise<Booking[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.prisma.booking.findMany({
      where: {
        memberId,
        status: 'confirmed',
        date: { gte: today },
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    }) as unknown as Booking[];
  }
}
