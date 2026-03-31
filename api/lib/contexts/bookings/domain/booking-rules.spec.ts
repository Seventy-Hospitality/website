import { bookingRules } from './booking-rules';
import type { TimeSlot } from './value-objects';
import {
  SlotUnavailableError,
  OutsideOperatingHoursError,
  InvalidSlotDurationError,
  CancellationDeadlinePassedError,
} from './errors';

describe('bookingRules', () => {
  describe('checkNoOverlap', () => {
    const newSlot: TimeSlot = { startTime: '10:00', endTime: '11:00' };

    it('passes with no existing bookings', () => {
      expect(() => bookingRules.checkNoOverlap([], newSlot)).not.toThrow();
    });

    it('passes with non-overlapping bookings', () => {
      const existing: TimeSlot[] = [
        { startTime: '08:00', endTime: '09:00' },
        { startTime: '11:00', endTime: '12:00' },
      ];
      expect(() => bookingRules.checkNoOverlap(existing, newSlot)).not.toThrow();
    });

    it('passes when adjacent slot ends exactly at new slot start', () => {
      const existing: TimeSlot[] = [{ startTime: '09:00', endTime: '10:00' }];
      expect(() => bookingRules.checkNoOverlap(existing, newSlot)).not.toThrow();
    });

    it('passes when adjacent slot starts exactly at new slot end', () => {
      const existing: TimeSlot[] = [{ startTime: '11:00', endTime: '12:00' }];
      expect(() => bookingRules.checkNoOverlap(existing, newSlot)).not.toThrow();
    });

    it('throws when an existing booking fully overlaps', () => {
      const existing: TimeSlot[] = [{ startTime: '10:00', endTime: '11:00' }];
      expect(() => bookingRules.checkNoOverlap(existing, newSlot)).toThrow(SlotUnavailableError);
    });

    it('throws when an existing booking partially overlaps (starts during new slot)', () => {
      const existing: TimeSlot[] = [{ startTime: '10:30', endTime: '11:30' }];
      expect(() => bookingRules.checkNoOverlap(existing, newSlot)).toThrow(SlotUnavailableError);
    });

    it('throws when an existing booking partially overlaps (ends during new slot)', () => {
      const existing: TimeSlot[] = [{ startTime: '09:30', endTime: '10:30' }];
      expect(() => bookingRules.checkNoOverlap(existing, newSlot)).toThrow(SlotUnavailableError);
    });

    it('throws when an existing booking contains the new slot', () => {
      const existing: TimeSlot[] = [{ startTime: '08:00', endTime: '13:00' }];
      expect(() => bookingRules.checkNoOverlap(existing, newSlot)).toThrow(SlotUnavailableError);
    });

    it('throws when any one of multiple existing bookings overlaps', () => {
      const existing: TimeSlot[] = [
        { startTime: '08:00', endTime: '09:00' },
        { startTime: '10:30', endTime: '11:30' }, // overlaps
        { startTime: '14:00', endTime: '15:00' },
      ];
      expect(() => bookingRules.checkNoOverlap(existing, newSlot)).toThrow(SlotUnavailableError);
    });
  });

  describe('checkOperatingHours', () => {
    const opStart = '08:00';
    const opEnd = '22:00';

    it('passes when slot is within operating hours', () => {
      const slot: TimeSlot = { startTime: '10:00', endTime: '11:00' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).not.toThrow();
    });

    it('passes when slot starts exactly at operating start', () => {
      const slot: TimeSlot = { startTime: '08:00', endTime: '09:00' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).not.toThrow();
    });

    it('passes when slot ends exactly at operating end', () => {
      const slot: TimeSlot = { startTime: '21:00', endTime: '22:00' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).not.toThrow();
    });

    it('passes when slot spans the entire operating window', () => {
      const slot: TimeSlot = { startTime: '08:00', endTime: '22:00' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).not.toThrow();
    });

    it('throws when slot starts before operating hours', () => {
      const slot: TimeSlot = { startTime: '07:00', endTime: '08:00' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).toThrow(
        OutsideOperatingHoursError,
      );
    });

    it('throws when slot ends after operating hours', () => {
      const slot: TimeSlot = { startTime: '21:00', endTime: '23:00' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).toThrow(
        OutsideOperatingHoursError,
      );
    });

    it('throws when slot is entirely outside operating hours', () => {
      const slot: TimeSlot = { startTime: '05:00', endTime: '06:00' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).toThrow(
        OutsideOperatingHoursError,
      );
    });

    it('throws when slot starts 1 minute before operating hours', () => {
      const slot: TimeSlot = { startTime: '07:59', endTime: '09:00' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).toThrow(
        OutsideOperatingHoursError,
      );
    });

    it('throws when slot ends 1 minute after operating hours', () => {
      const slot: TimeSlot = { startTime: '21:00', endTime: '22:01' };
      expect(() => bookingRules.checkOperatingHours(slot, opStart, opEnd)).toThrow(
        OutsideOperatingHoursError,
      );
    });
  });

  describe('checkSlotDuration', () => {
    it('passes when duration matches expected', () => {
      const slot: TimeSlot = { startTime: '09:00', endTime: '10:00' };
      expect(() => bookingRules.checkSlotDuration(slot, 60)).not.toThrow();
    });

    it('passes for 30-minute slot', () => {
      const slot: TimeSlot = { startTime: '09:00', endTime: '09:30' };
      expect(() => bookingRules.checkSlotDuration(slot, 30)).not.toThrow();
    });

    it('passes for 90-minute slot', () => {
      const slot: TimeSlot = { startTime: '09:00', endTime: '10:30' };
      expect(() => bookingRules.checkSlotDuration(slot, 90)).not.toThrow();
    });

    it('throws when actual duration is shorter than expected', () => {
      const slot: TimeSlot = { startTime: '09:00', endTime: '09:30' };
      expect(() => bookingRules.checkSlotDuration(slot, 60)).toThrow(InvalidSlotDurationError);
    });

    it('throws when actual duration is longer than expected', () => {
      const slot: TimeSlot = { startTime: '09:00', endTime: '11:00' };
      expect(() => bookingRules.checkSlotDuration(slot, 60)).toThrow(InvalidSlotDurationError);
    });

    it('throws when off by 1 minute', () => {
      const slot: TimeSlot = { startTime: '09:00', endTime: '10:01' };
      expect(() => bookingRules.checkSlotDuration(slot, 60)).toThrow(InvalidSlotDurationError);
    });
  });

  describe('checkCancellationDeadline', () => {
    const bookingDate = new Date('2026-04-15');
    const bookingStartTime = '10:00';
    const deadlineMinutes = 60; // 1 hour before

    it('passes when cancelling well before the deadline', () => {
      const now = new Date('2026-04-15T07:00:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, deadlineMinutes, now),
      ).not.toThrow();
    });

    it('passes when cancelling 1 minute before the deadline', () => {
      // Deadline is 09:00 (10:00 - 60min). Cancel at 08:59.
      const now = new Date('2026-04-15T08:59:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, deadlineMinutes, now),
      ).not.toThrow();
    });

    it('throws when cancelling exactly at the deadline', () => {
      // Deadline cutoff is 09:00. now >= cutoff triggers error.
      const now = new Date('2026-04-15T09:00:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, deadlineMinutes, now),
      ).toThrow(CancellationDeadlinePassedError);
    });

    it('throws when cancelling after the deadline', () => {
      const now = new Date('2026-04-15T09:30:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, deadlineMinutes, now),
      ).toThrow(CancellationDeadlinePassedError);
    });

    it('throws when cancelling after the booking has started', () => {
      const now = new Date('2026-04-15T10:30:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, deadlineMinutes, now),
      ).toThrow(CancellationDeadlinePassedError);
    });

    it('passes when cancelling the day before', () => {
      const now = new Date('2026-04-14T20:00:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, deadlineMinutes, now),
      ).not.toThrow();
    });

    it('works with a 0-minute deadline (must cancel before start)', () => {
      const now = new Date('2026-04-15T09:59:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, 0, now),
      ).not.toThrow();
    });

    it('throws with 0-minute deadline when cancelling at start time', () => {
      const now = new Date('2026-04-15T10:00:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, 0, now),
      ).toThrow(CancellationDeadlinePassedError);
    });

    it('works with a large deadline (24 hours)', () => {
      const now = new Date('2026-04-14T09:59:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, 1440, now),
      ).not.toThrow();
    });

    it('throws with 24-hour deadline when cancelling at cutoff', () => {
      const now = new Date('2026-04-14T10:00:00');
      expect(() =>
        bookingRules.checkCancellationDeadline(bookingDate, bookingStartTime, 1440, now),
      ).toThrow(CancellationDeadlinePassedError);
    });
  });
});
