import {
  InvalidParticipantTransitionError,
  OrganizerCannotRespondError,
} from './errors';

export type ReservationStatus = 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
export type ParticipantRole = 'organizer' | 'guest';
export type ParticipantStatus = 'confirmed' | 'pending' | 'declined' | 'withdrawn';
export type ParticipantResponse = 'accept' | 'decline';
export type PaymentKind = 'charge' | 'refund';

export interface Reservation {
  id: string;
  reference: string;
  resourceTypeId: string;
  resourceId: string;
  organizerId: string;
  clubId: string | null;
  seriesId: string | null;
  startsAt: Date;
  endsAt: Date;
  localDate: string;
  status: ReservationStatus;
  hourlyRateCentsSnapshot: number;
  amountPaidCents: number;
  createdByAdminId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReservationParticipant {
  id: string;
  reservationId: string;
  memberId: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  invitedById: string | null;
  viaClubId: string | null;
  invitedAt: Date;
  respondedAt: Date | null;
}

export interface ReservationPayment {
  id: string;
  reservationId: string;
  kind: PaymentKind;
  amountCents: number; // always positive; kind carries the direction
  stripePaymentIntentId: string | null;
  stripeRefundId: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  createdAt: Date;
}

/** Statuses under which a reservation still owns its slot. */
export function isActiveReservationStatus(status: ReservationStatus): boolean {
  return status === 'pending_payment' || status === 'confirmed';
}

/**
 * The participant state machine for the respond endpoint.
 *
 * - pending  + accept  -> confirmed
 * - pending  + decline -> declined      (row is kept; re-invite is an update)
 * - confirmed + decline -> withdrawn    (withdraw after accept)
 * - confirmed + accept, declined + decline, withdrawn + decline: idempotent
 * - declined/withdrawn + accept: invalid; changing your mind needs a re-invite
 *
 * The organizer has no invitation to respond to.
 */
export function applyParticipantResponse(
  participant: Pick<ReservationParticipant, 'role' | 'status'>,
  response: ParticipantResponse,
): ParticipantStatus {
  if (participant.role === 'organizer') throw new OrganizerCannotRespondError();

  const current = participant.status;
  if (response === 'accept') {
    if (current === 'pending' || current === 'confirmed') return 'confirmed';
    throw new InvalidParticipantTransitionError(current, response);
  }

  if (current === 'confirmed') return 'withdrawn';
  if (current === 'pending' || current === 'declined') return 'declined';
  return 'withdrawn'; // withdrawn + decline: idempotent
}

/**
 * Who may add invitees: the organizer and confirmed participants
 * (settled product decision 6).
 */
export function canManageInvites(
  viewer: Pick<ReservationParticipant, 'role' | 'status'> | null | undefined,
): boolean {
  if (!viewer) return false;
  if (viewer.role === 'organizer') return true;
  return viewer.status === 'confirmed';
}
