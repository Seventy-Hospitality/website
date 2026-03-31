import {
  type FacilityType,
  type MembershipChecker,
  createTimeSlot,
  generateAvailableSlots,
  bookingRules,
  BookingNotFoundError,
  FacilityNotFoundError,
  MaxBookingsExceededError,
  BookingTooFarInAdvanceError,
  BookingInPastError,
  InactiveMembershipError,
} from '../domain';
import type { CourtRepository, CreateCourtInput, UpdateCourtInput } from '../infrastructure/court.repository';
import type { ShowerRepository, CreateShowerInput, UpdateShowerInput } from '../infrastructure/shower.repository';
import type { BookingRepository } from '../infrastructure/booking.repository';
import type { UnitOfWork } from '@/lib/kernel/unit-of-work';

export class BookingService {
  constructor(
    private readonly courtRepo: CourtRepository,
    private readonly showerRepo: ShowerRepository,
    private readonly bookingRepo: BookingRepository,
    private readonly membershipChecker: MembershipChecker,
    private readonly uow: UnitOfWork,
  ) {}

  async bookCourt(courtId: string, date: string, startTime: string, memberId: string) {
    const court = await this.courtRepo.getById(courtId);
    if (!court || !court.active) throw new FacilityNotFoundError('Court', courtId);

    const slot = createTimeSlot(startTime, court.slotDurationMinutes);
    const bookingDate = new Date(date);

    await this.validatePreconditions(bookingDate, court.maxAdvanceDays, memberId);

    return this.uow.execute(async (tx) => {
      const existing = await this.bookingRepo.getConfirmedForFacility(tx, 'court', courtId, bookingDate);
      bookingRules.checkNoOverlap(existing, slot);
      bookingRules.checkOperatingHours(slot, court.operatingHoursStart, court.operatingHoursEnd);

      const count = await this.bookingRepo.countMemberBookings(tx, memberId, bookingDate, 'court');
      if (count >= court.maxBookingsPerMemberPerDay) {
        throw new MaxBookingsExceededError(court.maxBookingsPerMemberPerDay);
      }

      return this.bookingRepo.create(tx, {
        facilityType: 'court',
        facilityId: courtId,
        memberId,
        date: bookingDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
    });
  }

  async bookShower(showerId: string, date: string, startTime: string, memberId: string) {
    const shower = await this.showerRepo.getById(showerId);
    if (!shower || !shower.active) throw new FacilityNotFoundError('Shower', showerId);

    const slot = createTimeSlot(startTime, shower.slotDurationMinutes);
    const bookingDate = new Date(date);

    await this.validatePreconditions(bookingDate, shower.maxAdvanceDays, memberId);

    return this.uow.execute(async (tx) => {
      const existing = await this.bookingRepo.getConfirmedForFacility(tx, 'shower', showerId, bookingDate);
      bookingRules.checkNoOverlap(existing, slot);
      bookingRules.checkOperatingHours(slot, shower.operatingHoursStart, shower.operatingHoursEnd);

      const count = await this.bookingRepo.countMemberBookings(tx, memberId, bookingDate, 'shower');
      if (count >= shower.maxBookingsPerMemberPerDay) {
        throw new MaxBookingsExceededError(shower.maxBookingsPerMemberPerDay);
      }

      return this.bookingRepo.create(tx, {
        facilityType: 'shower',
        facilityId: showerId,
        memberId,
        date: bookingDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
    });
  }

  async cancel(bookingId: string, memberId: string) {
    const booking = await this.bookingRepo.getById(bookingId);
    if (!booking || booking.memberId !== memberId) throw new BookingNotFoundError(bookingId);
    if (booking.status !== 'confirmed') throw new BookingNotFoundError(bookingId);

    // Load facility config for cancellation deadline
    const deadline = await this.getCancellationDeadline(booking.facilityType, booking.facilityId);
    bookingRules.checkCancellationDeadline(booking.date, booking.startTime, deadline, new Date());

    await this.bookingRepo.cancel(bookingId);
  }

  async getCourtAvailability(courtId: string, date: string) {
    const court = await this.courtRepo.getById(courtId);
    if (!court || !court.active) throw new FacilityNotFoundError('Court', courtId);

    const bookingDate = new Date(date);
    const existing = await this.bookingRepo.getUpcomingForFacility('court', courtId, bookingDate);
    return generateAvailableSlots(
      court.operatingHoursStart,
      court.operatingHoursEnd,
      court.slotDurationMinutes,
      existing,
    );
  }

  async getShowerAvailability(showerId: string, date: string) {
    const shower = await this.showerRepo.getById(showerId);
    if (!shower || !shower.active) throw new FacilityNotFoundError('Shower', showerId);

    const bookingDate = new Date(date);
    const existing = await this.bookingRepo.getUpcomingForFacility('shower', showerId, bookingDate);
    return generateAvailableSlots(
      shower.operatingHoursStart,
      shower.operatingHoursEnd,
      shower.slotDurationMinutes,
      existing,
    );
  }

  async adminCancel(bookingId: string) {
    const booking = await this.bookingRepo.getById(bookingId);
    if (!booking) throw new BookingNotFoundError(bookingId);
    if (booking.status !== 'confirmed') throw new BookingNotFoundError(bookingId);
    await this.bookingRepo.cancel(bookingId);
  }

  async listBookings(date?: string) {
    return this.bookingRepo.listAll(date ? new Date(date) : undefined);
  }

  async getMyBookings(memberId: string) {
    return this.bookingRepo.getUpcomingForMember(memberId);
  }

  async listCourts() {
    return this.courtRepo.listActive();
  }

  async listAllCourts() {
    return this.courtRepo.listAll();
  }

  async createCourt(data: CreateCourtInput) {
    return this.courtRepo.create(data);
  }

  async updateCourt(id: string, data: UpdateCourtInput) {
    const court = await this.courtRepo.getById(id);
    if (!court) throw new FacilityNotFoundError('Court', id);
    return this.courtRepo.update(id, data);
  }

  async countUpcomingBookings(facilityType: 'court' | 'shower', facilityId: string) {
    return this.bookingRepo.countUpcomingForFacility(facilityType, facilityId);
  }

  async listShowers() {
    return this.showerRepo.listActive();
  }

  async listAllShowers() {
    return this.showerRepo.listAll();
  }

  async createShower(data: CreateShowerInput) {
    return this.showerRepo.create(data);
  }

  async updateShower(id: string, data: UpdateShowerInput) {
    const shower = await this.showerRepo.getById(id);
    if (!shower) throw new FacilityNotFoundError('Shower', id);
    return this.showerRepo.update(id, data);
  }

  private async validatePreconditions(date: Date, maxAdvanceDays: number, memberId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (date < today) throw new BookingInPastError();

    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + maxAdvanceDays);
    if (date > maxDate) throw new BookingTooFarInAdvanceError(maxAdvanceDays);

    const hasActive = await this.membershipChecker.hasActiveMembership(memberId);
    if (!hasActive) throw new InactiveMembershipError();
  }

  private async getCancellationDeadline(facilityType: FacilityType, facilityId: string): Promise<number> {
    if (facilityType === 'court') {
      const court = await this.courtRepo.getById(facilityId);
      return court?.cancellationDeadlineMinutes ?? 60;
    }
    const shower = await this.showerRepo.getById(facilityId);
    return shower?.cancellationDeadlineMinutes ?? 30;
  }
}
