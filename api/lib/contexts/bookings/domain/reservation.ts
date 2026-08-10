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
  /**
   * The refund percent the cancellation actually applied; lets a charge
   * that captures after the cancel refund at the same percent.
   */
  cancelRefundPercent: number | null;
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
  /** What a charge paid for: the base booking or a reschedule-grow delta. */
  purpose: 'base' | 'change_delta';
  amountCents: number; // always positive; kind carries the direction
  stripePaymentIntentId: string | null;
  stripeRefundId: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  /**
   * Financial freeze (charge.dispute.created): a disputed charge cannot be
   * refunded at Stripe, so it is excluded from refundable balance while
   * still counting as captured money.
   */
  disputedAt: Date | null;
  createdAt: Date;
}

/**
 * A requested reschedule-GROW waiting for its delta charge. The claim move
 * only takes physical effect once the delta PaymentIntent succeeds; until
 * then the reservation keeps its existing claim, so an abandoned payment can
 * never leave extra time uncharged or strand the original booking.
 */
export interface ReservationPendingChange {
  id: string;
  reservationId: string;
  /** Preferred landing resource, re-validated when the change is applied. */
  resourceId: string;
  startsAt: Date;
  endsAt: Date;
  localDate: string;
  /** Always positive: shrink/equal reschedules apply immediately. */
  deltaCents: number;
  chargePaymentId: string;
  expiresAt: Date;
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
