import { type TimeSlot, slotsOverlap, timeToMinutes } from './value-objects';
import {
  SlotUnavailableError,
  OutsideOperatingHoursError,
  InvalidSlotDurationError,
  CancellationDeadlinePassedError,
} from './errors';

export const bookingRules = {
  /** No overlapping confirmed bookings for the same facility on the same date */
  checkNoOverlap(existingBookings: TimeSlot[], newSlot: TimeSlot): void {
    if (existingBookings.some((b) => slotsOverlap(b, newSlot))) {
      throw new SlotUnavailableError();
    }
  },

  /** Slot must fit within facility operating hours */
  checkOperatingHours(slot: TimeSlot, operatingStart: string, operatingEnd: string): void {
    const slotStart = timeToMinutes(slot.startTime);
    const slotEnd = timeToMinutes(slot.endTime);
    const opStart = timeToMinutes(operatingStart);
    const opEnd = timeToMinutes(operatingEnd);

    if (slotStart < opStart || slotEnd > opEnd) {
      throw new OutsideOperatingHoursError(operatingStart, operatingEnd);
    }
  },

  /** Slot duration must match facility config */
  checkSlotDuration(slot: TimeSlot, expectedMinutes: number): void {
    const actual = timeToMinutes(slot.endTime) - timeToMinutes(slot.startTime);
    if (actual !== expectedMinutes) {
      throw new InvalidSlotDurationError(expectedMinutes);
    }
  },

  /** Cancellation deadline not passed */
  checkCancellationDeadline(
    bookingDate: Date,
    bookingStartTime: string,
    deadlineMinutes: number,
    now: Date,
  ): void {
    const [h, m] = bookingStartTime.split(':').map(Number);
    const bookingStart = new Date(bookingDate);
    bookingStart.setHours(h, m, 0, 0);

    const deadlineMs = deadlineMinutes * 60 * 1000;
    const cutoff = new Date(bookingStart.getTime() - deadlineMs);

    if (now >= cutoff) {
      throw new CancellationDeadlinePassedError(deadlineMinutes);
    }
  },
};
