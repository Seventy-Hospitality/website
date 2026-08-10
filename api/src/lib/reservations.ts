import type { FastifyReply } from 'fastify';
import { minutesToTimeLabel, zonedMinutesSinceMidnight } from '@/lib/kernel';
import { MinimumChargeNotMetError } from '@/lib/contexts/billing/domain';
import {
  type ReservationDetailRecord,
  CannotRemoveOrganizerError,
  HoldExpiredError,
  InactiveMembershipError,
  InsufficientRefundableBalanceError,
  InvalidParticipantTransitionError,
  InvalidReservationStatusError,
  InvalidSlotSelectionError,
  InviteeNotFoundError,
  MaxReservationsExceededError,
  ReservationChangedError,
  NotInvitePermittedError,
  NotReservationOrganizerError,
  OrganizerCannotRespondError,
  OutsideOperatingHoursError,
  ParticipantNotFoundError,
  PaymentNotCompletedError,
  ReservationAlreadyStartedError,
  ReservationInPastError,
  ReservationNotFoundError,
  ReservationTooFarInAdvanceError,
  ResourceNotFoundError,
  ResourceTypeNotFoundError,
  SlotUnavailableError,
  TierRequiredError,
} from '@/lib/contexts/bookings';
import { error } from './responses';

export function serializeReservation(
  detail: ReservationDetailRecord,
  options: { timezone: string; viewerMemberId?: string },
) {
  const startMinutes = zonedMinutesSinceMidnight(detail.startsAt, options.timezone, detail.localDate);
  const endMinutes = zonedMinutesSinceMidnight(detail.endsAt, options.timezone, detail.localDate);
  const durationMinutes = endMinutes - startMinutes;

  const viewer = options.viewerMemberId
    ? detail.participants.find((participant) => participant.memberId === options.viewerMemberId)
    : undefined;
  const inviter = viewer?.invitedById
    ? detail.participants.find((participant) => participant.memberId === viewer.invitedById)
    : undefined;

  return {
    id: detail.id,
    reference: detail.reference,
    typeCode: detail.resourceType.code,
    typeName: detail.resourceType.name,
    resource: { id: detail.resource.id, name: detail.resource.name },
    date: detail.localDate,
    startTime: minutesToTimeLabel(startMinutes),
    endTime: minutesToTimeLabel(endMinutes),
    startsAt: detail.startsAt.toISOString(),
    endsAt: detail.endsAt.toISOString(),
    durationMinutes,
    status: detail.status,
    hourlyRateCents: detail.hourlyRateCentsSnapshot,
    amountPaidCents: detail.amountPaidCents,
    clubId: detail.clubId,
    seriesId: detail.seriesId,
    createdByAdmin: detail.createdByAdminId !== null,
    participants: detail.participants.map((participant) => ({
      memberId: participant.memberId,
      firstName: participant.member.firstName,
      lastName: participant.member.lastName,
      role: participant.role,
      status: participant.status,
      invitedById: participant.invitedById,
    })),
    ...(detail.pendingChange
      ? {
          // A reschedule-grow awaiting its delta payment; the reservation
          // keeps its current range until the delta is captured.
          pendingChange: {
            date: detail.pendingChange.localDate,
            startTime: minutesToTimeLabel(
              zonedMinutesSinceMidnight(detail.pendingChange.startsAt, options.timezone, detail.pendingChange.localDate),
            ),
            endTime: minutesToTimeLabel(
              zonedMinutesSinceMidnight(detail.pendingChange.endsAt, options.timezone, detail.pendingChange.localDate),
            ),
            deltaCents: detail.pendingChange.deltaCents,
            expiresAt: detail.pendingChange.expiresAt.toISOString(),
          },
        }
      : { pendingChange: null }),
    ...(viewer
      ? {
          myParticipation: {
            role: viewer.role,
            status: viewer.status,
            invitedByName: inviter
              ? `${inviter.member.firstName} ${inviter.member.lastName}`.trim()
              : null,
          },
        }
      : {}),
  };
}

/**
 * The admin web's pre-cutover booking shape, served from reservations.
 *
 * The organizer's email is PII: it is included only for the admin surface
 * (`audience: 'admin'`) or when the viewer IS the organizer. Member-facing
 * routes list reservations the caller merely participates in, and a guest
 * must not read the organizer's address, so the default fails closed.
 */
export function serializeLegacyBooking(
  detail: ReservationDetailRecord,
  timezone: string,
  options: { audience?: 'admin' | 'member'; viewerMemberId?: string } = {},
) {
  const startMinutes = zonedMinutesSinceMidnight(detail.startsAt, timezone, detail.localDate);
  const endMinutes = zonedMinutesSinceMidnight(detail.endsAt, timezone, detail.localDate);
  const organizer = detail.participants.find((participant) => participant.role === 'organizer');
  const includeEmail =
    options.audience === 'admin' ||
    (organizer !== undefined && organizer.memberId === options.viewerMemberId);

  return {
    id: detail.id,
    facilityType: legacyFacilityType(detail.resourceType.code),
    facilityId: detail.resource.id,
    facilityName: detail.resource.name,
    memberId: detail.organizerId,
    member: organizer
      ? {
          id: organizer.member.id,
          firstName: organizer.member.firstName,
          lastName: organizer.member.lastName,
          email: includeEmail ? organizer.member.email : null,
        }
      : null,
    date: detail.localDate,
    startTime: minutesToTimeLabel(startMinutes),
    endTime: minutesToTimeLabel(endMinutes),
    status: detail.status,
  };
}

export function legacyFacilityType(code: string): string {
  if (code === 'shower') return 'shower';
  if (code === 'badminton_court' || code === 'tennis_court') return 'court';
  return code;
}

export function handleReservationError(reply: FastifyReply, err: unknown) {
  if (err instanceof ResourceTypeNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof ResourceNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof ReservationNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof ParticipantNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof InviteeNotFoundError) return error(reply, 'INVITEE_NOT_FOUND', err.message, 404);
  if (err instanceof SlotUnavailableError) return error(reply, 'SLOT_UNAVAILABLE', err.message, 409);
  if (err instanceof HoldExpiredError) return error(reply, 'HOLD_EXPIRED', err.message, 409);
  if (err instanceof InvalidReservationStatusError) return error(reply, 'INVALID_STATUS', err.message, 409);
  if (err instanceof InvalidParticipantTransitionError) return error(reply, 'INVALID_RESPONSE', err.message, 409);
  if (err instanceof InsufficientRefundableBalanceError) return error(reply, 'REFUND_UNAVAILABLE', err.message, 409);
  if (err instanceof ReservationChangedError) return error(reply, 'RESERVATION_CHANGED', err.message, 409);
  if (err instanceof OutsideOperatingHoursError) return error(reply, 'OUTSIDE_HOURS', err.message, 422);
  if (err instanceof InvalidSlotSelectionError) return error(reply, 'INVALID_SLOTS', err.message, 422);
  if (err instanceof MaxReservationsExceededError) return error(reply, 'MAX_BOOKINGS', err.message, 422);
  if (err instanceof ReservationTooFarInAdvanceError) return error(reply, 'TOO_FAR_ADVANCE', err.message, 422);
  if (err instanceof ReservationInPastError) return error(reply, 'BOOKING_IN_PAST', err.message, 422);
  if (err instanceof ReservationAlreadyStartedError) return error(reply, 'ALREADY_STARTED', err.message, 422);
  if (err instanceof OrganizerCannotRespondError) return error(reply, 'ORGANIZER_CANNOT_RESPOND', err.message, 422);
  if (err instanceof CannotRemoveOrganizerError) return error(reply, 'CANNOT_REMOVE_ORGANIZER', err.message, 422);
  if (err instanceof TierRequiredError) return error(reply, 'TIER_REQUIRED', err.message, 403);
  if (err instanceof InactiveMembershipError) return error(reply, 'INACTIVE_MEMBERSHIP', err.message, 403);
  if (err instanceof NotInvitePermittedError) return error(reply, 'FORBIDDEN', err.message, 403);
  if (err instanceof NotReservationOrganizerError) return error(reply, 'FORBIDDEN', err.message, 403);
  if (err instanceof PaymentNotCompletedError) return error(reply, 'PAYMENT_REQUIRED', err.message, 402);
  // A reschedule delta below Stripe's $0.50 card minimum cannot be charged
  // (settled decision: block, not absorb).
  if (err instanceof MinimumChargeNotMetError) return error(reply, 'PAYMENT_TOO_SMALL', err.message, 422);
  throw err;
}
