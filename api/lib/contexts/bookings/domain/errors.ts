export class SlotUnavailableError extends Error {
  constructor() {
    super('This time slot is already booked');
    this.name = 'SlotUnavailableError';
  }
}

export class OutsideOperatingHoursError extends Error {
  constructor(start: string, end: string) {
    super(`Booking must be within operating hours (${start}–${end})`);
    this.name = 'OutsideOperatingHoursError';
  }
}

export class InvalidSlotDurationError extends Error {
  constructor(expected: number) {
    super(`Slot duration must be ${expected} minutes`);
    this.name = 'InvalidSlotDurationError';
  }
}

export class MaxBookingsExceededError extends Error {
  constructor(max: number) {
    super(`Maximum of ${max} bookings per day exceeded`);
    this.name = 'MaxBookingsExceededError';
  }
}

export class BookingTooFarInAdvanceError extends Error {
  constructor(maxDays: number) {
    super(`Cannot book more than ${maxDays} days in advance`);
    this.name = 'BookingTooFarInAdvanceError';
  }
}

export class BookingInPastError extends Error {
  constructor() {
    super('Cannot book a slot in the past');
    this.name = 'BookingInPastError';
  }
}

export class CancellationDeadlinePassedError extends Error {
  constructor(minutes: number) {
    super(`Bookings must be cancelled at least ${minutes} minutes before start`);
    this.name = 'CancellationDeadlinePassedError';
  }
}

export class BookingNotFoundError extends Error {
  constructor(id: string) {
    super(`Booking not found: ${id}`);
    this.name = 'BookingNotFoundError';
  }
}

export class FacilityNotFoundError extends Error {
  constructor(type: string, id: string) {
    super(`${type} not found: ${id}`);
    this.name = 'FacilityNotFoundError';
  }
}

export class InactiveMembershipError extends Error {
  constructor() {
    super('An active membership is required to make bookings');
    this.name = 'InactiveMembershipError';
  }
}
