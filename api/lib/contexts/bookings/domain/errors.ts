import { minutesToTimeLabel } from '@/lib/kernel';

export class SlotUnavailableError extends Error {
  constructor() {
    super('This time slot is already booked');
    this.name = 'SlotUnavailableError';
  }
}

export class OutsideOperatingHoursError extends Error {
  constructor(opStartMinutes: number, opEndMinutes: number) {
    super(
      `Booking must be within operating hours (${minutesToTimeLabel(opStartMinutes)}–${minutesToTimeLabel(opEndMinutes)})`,
    );
    this.name = 'OutsideOperatingHoursError';
  }
}

export class InvalidSlotSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSlotSelectionError';
  }
}

export class MaxReservationsExceededError extends Error {
  constructor(max: number) {
    super(`Maximum of ${max} reservations per day exceeded`);
    this.name = 'MaxReservationsExceededError';
  }
}

export class ReservationTooFarInAdvanceError extends Error {
  constructor(maxDays: number) {
    super(`Cannot book more than ${maxDays} days in advance`);
    this.name = 'ReservationTooFarInAdvanceError';
  }
}

export class ReservationInPastError extends Error {
  constructor() {
    super('Cannot book a slot in the past');
    this.name = 'ReservationInPastError';
  }
}

export class ReservationNotFoundError extends Error {
  constructor(id: string) {
    super(`Reservation not found: ${id}`);
    this.name = 'ReservationNotFoundError';
  }
}

export class ResourceTypeNotFoundError extends Error {
  constructor(code: string) {
    super(`Resource type not found: ${code}`);
    this.name = 'ResourceTypeNotFoundError';
  }
}

export class ResourceNotFoundError extends Error {
  constructor(id: string) {
    super(`Resource not found: ${id}`);
    this.name = 'ResourceNotFoundError';
  }
}

export class NotReservationOrganizerError extends Error {
  constructor() {
    super('Only the reservation organizer can do this');
    this.name = 'NotReservationOrganizerError';
  }
}

export class TierRequiredError extends Error {
  constructor(minTier: string) {
    super(`A ${minTier.toUpperCase()} membership is required for this facility`);
    this.name = 'TierRequiredError';
  }
}

export class InactiveMembershipError extends Error {
  constructor() {
    super('An active membership is required to make bookings');
    this.name = 'InactiveMembershipError';
  }
}

export class InvalidReservationStatusError extends Error {
  constructor(status: string, expected: string) {
    super(`Reservation is ${status}; expected ${expected}`);
    this.name = 'InvalidReservationStatusError';
  }
}

export class ReservationAlreadyStartedError extends Error {
  constructor() {
    super('This reservation has already started');
    this.name = 'ReservationAlreadyStartedError';
  }
}

export class InvalidParticipantTransitionError extends Error {
  constructor(current: string, response: string) {
    super(`Cannot ${response} an invitation that is ${current}`);
    this.name = 'InvalidParticipantTransitionError';
  }
}

export class OrganizerCannotRespondError extends Error {
  constructor() {
    super('The organizer cannot respond to their own reservation');
    this.name = 'OrganizerCannotRespondError';
  }
}

export class ParticipantNotFoundError extends Error {
  constructor() {
    super('No invitation found for this member');
    this.name = 'ParticipantNotFoundError';
  }
}

export class CannotRemoveOrganizerError extends Error {
  constructor() {
    super('The organizer cannot be removed from a reservation');
    this.name = 'CannotRemoveOrganizerError';
  }
}

export class NotInvitePermittedError extends Error {
  constructor() {
    super('Only the organizer and confirmed participants can invite');
    this.name = 'NotInvitePermittedError';
  }
}

export class InviteeNotFoundError extends Error {
  constructor(ids: string[]) {
    super(`Member not found: ${ids.join(', ')}`);
    this.name = 'InviteeNotFoundError';
  }
}

/**
 * A club-chip invite naming a club the inviter does not belong to (or that
 * does not exist: identical answer, no probing). 404-shaped on the wire.
 */
export class ClubInviteNotAllowedError extends Error {
  constructor() {
    super('Club not found');
    this.name = 'ClubInviteNotAllowedError';
  }
}

export class PaymentNotCompletedError extends Error {
  constructor() {
    super('Payment has not completed for this reservation');
    this.name = 'PaymentNotCompletedError';
  }
}

export class HoldExpiredError extends Error {
  constructor() {
    super('The hold on this reservation has expired');
    this.name = 'HoldExpiredError';
  }
}

// Thrown by the shared allocator in the kernel; re-exported here so the
// bookings barrel keeps serving it.
export { InsufficientRefundableBalanceError } from '@/lib/kernel';

export class ReservationChangedError extends Error {
  constructor() {
    super('This reservation changed while the request was in flight; get a fresh quote and retry');
    this.name = 'ReservationChangedError';
  }
}
