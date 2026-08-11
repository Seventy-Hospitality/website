import type { NotificationPreferences } from './preferences';

// ── Notification decision matrix (pure) ──
//
// Maps an outbox event (audit-log row) to WHO should hear about it and over
// WHICH channels. No IO: recipients that require a lookup (a reservation's
// organizer, a club invitation's inviter) are returned as resolvable
// references the application layer expands through ports. The full matrix
// is recorded in docs/decisions-notifications.md.

/** The outbox row shape the decision runs on (a projection of Event). */
export interface OutboxEventLike {
  seq: number;
  streamType: string;
  streamId: string;
  eventType: string;
  data: unknown;
  actorId: string | null;
}

/**
 * A recipient, either literal or as a reference the dispatcher resolves.
 * `reservation_participants` means the reservation's current confirmed and
 * pending participants (declined/withdrawn members opted out of hearing
 * more about it).
 */
export type RecipientRef =
  | { kind: 'member'; memberId: string }
  | { kind: 'members'; memberIds: string[] }
  | { kind: 'reservation_organizer'; reservationId: string }
  | { kind: 'reservation_participants'; reservationId: string }
  | { kind: 'club_invitation_inviter'; invitationId: string }
  | { kind: 'staff' };

export type NotificationKind =
  | 'booking_invite'
  | 'booking_invite_accepted'
  | 'booking_invite_declined'
  | 'booking_participant_withdrawn'
  | 'booking_rescheduled'
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'booking_reminder'
  | 'series_booked'
  | 'series_occurrence_skipped'
  | 'club_invite'
  | 'club_invite_accepted'
  | 'id_verification_approved'
  | 'id_verification_rejected'
  | 'payment_failed'
  | 'staff_dispute_opened'
  | 'staff_refund_failed'
  | 'staff_deletion_blocked';

export interface NotificationDecision {
  kind: NotificationKind;
  recipient: RecipientRef;
}

export interface ChannelPolicy {
  push: boolean;
  email: boolean;
  /** Staff alerts go to the configured staff address and ignore member prefs. */
  audience: 'member' | 'staff';
  /**
   * Whether the acting principal is dropped from the recipient set. A
   * receipt for your own action (booking confirmation) keeps you; social
   * fan-out (accept/decline pings, cancellations) never echoes the actor.
   */
  suppressActor: boolean;
  /** Additionally gated by the independent bookingReminders toggle. */
  requiresReminderOptIn: boolean;
}

const MEMBER = { audience: 'member', requiresReminderOptIn: false } as const;

/**
 * Per-kind channel policy: which channels a kind uses AT ALL. Member
 * preferences (and device registration for push) gate further in
 * planChannels. Email-only kinds are receipts/records; push-only kinds are
 * lightweight social pings.
 */
export const CHANNEL_POLICIES: Record<NotificationKind, ChannelPolicy> = {
  booking_invite: { ...MEMBER, push: true, email: true, suppressActor: true },
  booking_invite_accepted: { ...MEMBER, push: true, email: false, suppressActor: true },
  booking_invite_declined: { ...MEMBER, push: true, email: false, suppressActor: true },
  booking_participant_withdrawn: { ...MEMBER, push: true, email: false, suppressActor: true },
  booking_rescheduled: { ...MEMBER, push: true, email: true, suppressActor: true },
  booking_confirmed: { ...MEMBER, push: false, email: true, suppressActor: false },
  booking_cancelled: { ...MEMBER, push: true, email: true, suppressActor: true },
  booking_reminder: { ...MEMBER, push: true, email: true, suppressActor: false, requiresReminderOptIn: true },
  series_booked: { ...MEMBER, push: true, email: true, suppressActor: false },
  series_occurrence_skipped: { ...MEMBER, push: true, email: true, suppressActor: false },
  club_invite: { ...MEMBER, push: true, email: true, suppressActor: true },
  club_invite_accepted: { ...MEMBER, push: true, email: false, suppressActor: true },
  id_verification_approved: { ...MEMBER, push: true, email: true, suppressActor: true },
  id_verification_rejected: { ...MEMBER, push: true, email: true, suppressActor: true },
  payment_failed: { ...MEMBER, push: false, email: true, suppressActor: false },
  staff_dispute_opened: { push: false, email: true, audience: 'staff', suppressActor: false, requiresReminderOptIn: false },
  staff_refund_failed: { push: false, email: true, audience: 'staff', suppressActor: false, requiresReminderOptIn: false },
  staff_deletion_blocked: { push: false, email: true, audience: 'staff', suppressActor: false, requiresReminderOptIn: false },
};

export interface ChannelPlan {
  push: boolean;
  email: boolean;
}

/**
 * Final channel gate for one recipient: the kind's channel policy AND the
 * member's toggles AND (for push) a registered device. Staff alerts ignore
 * preferences: they are operational, not a subscription.
 */
export function planChannels(
  kind: NotificationKind,
  prefs: NotificationPreferences,
  hasRegisteredDevice: boolean,
): ChannelPlan {
  const policy = CHANNEL_POLICIES[kind];
  if (policy.audience === 'staff') {
    return { push: false, email: policy.email };
  }
  if (policy.requiresReminderOptIn && !prefs.bookingReminders) {
    return { push: false, email: false };
  }
  return {
    push: policy.push && prefs.pushNotifications && hasRegisteredDevice,
    email: policy.email && prefs.emailNotifications,
  };
}

function asRecord(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * The event -> notification matrix. Unmapped event types (the bulk of the
 * audit log) decide to notify nobody; malformed payloads fail silent rather
 * than poisoning the outbox with a permanent throw.
 */
export function decideNotifications(event: OutboxEventLike): NotificationDecision[] {
  const data = asRecord(event.data);

  switch (event.eventType) {
    case 'reservation.participant_invited': {
      const memberId = asString(data.memberId);
      return memberId ? [{ kind: 'booking_invite', recipient: { kind: 'member', memberId } }] : [];
    }
    case 'reservation.invite_accepted':
      return [{ kind: 'booking_invite_accepted', recipient: { kind: 'reservation_organizer', reservationId: event.streamId } }];
    case 'reservation.invite_declined':
      return [{ kind: 'booking_invite_declined', recipient: { kind: 'reservation_organizer', reservationId: event.streamId } }];
    case 'reservation.participant_withdrawn':
      return [{ kind: 'booking_participant_withdrawn', recipient: { kind: 'reservation_organizer', reservationId: event.streamId } }];
    case 'reservation.rescheduled': {
      // Confirmed guests were reset to pending in the same transaction;
      // they are exactly the people who must re-accept.
      const reset = asStringArray(data.resetParticipants);
      return reset.length > 0
        ? [{ kind: 'booking_rescheduled', recipient: { kind: 'members', memberIds: reset } }]
        : [];
    }
    case 'reservation.confirmed':
      return [{ kind: 'booking_confirmed', recipient: { kind: 'reservation_organizer', reservationId: event.streamId } }];
    case 'reservation.cancelled':
      return [{ kind: 'booking_cancelled', recipient: { kind: 'reservation_participants', reservationId: event.streamId } }];
    case 'reservation.created': {
      // Only series materialization books on the member's behalf; a member's
      // own checkout is confirmed (and notified) via reservation.confirmed.
      return asString(data.seriesId)
        ? [{ kind: 'series_booked', recipient: { kind: 'reservation_organizer', reservationId: event.streamId } }]
        : [];
    }
    case 'reservation.refund_failed':
      return [{ kind: 'staff_refund_failed', recipient: { kind: 'staff' } }];
    case 'reservation_series.occurrence_skipped': {
      const organizerId = asString(data.organizerId);
      return organizerId
        ? [{ kind: 'series_occurrence_skipped', recipient: { kind: 'member', memberId: organizerId } }]
        : [];
    }
    case 'club.invitation_sent': {
      const inviteeMemberId = asString(data.inviteeMemberId);
      return inviteeMemberId
        ? [{ kind: 'club_invite', recipient: { kind: 'member', memberId: inviteeMemberId } }]
        : [];
    }
    case 'club.invitation_accepted': {
      const invitationId = asString(data.invitationId);
      return invitationId
        ? [{ kind: 'club_invite_accepted', recipient: { kind: 'club_invitation_inviter', invitationId } }]
        : [];
    }
    case 'id_verification.approved':
      return [{ kind: 'id_verification_approved', recipient: { kind: 'member', memberId: event.streamId } }];
    case 'id_verification.rejected':
      return [{ kind: 'id_verification_rejected', recipient: { kind: 'member', memberId: event.streamId } }];
    case 'billing.payment_failed': {
      const memberId = asString(data.memberId) ?? asString(event.streamId);
      return memberId ? [{ kind: 'payment_failed', recipient: { kind: 'member', memberId } }] : [];
    }
    case 'billing.dispute_opened':
      return [{ kind: 'staff_dispute_opened', recipient: { kind: 'staff' } }];
    case 'account.deletion_blocked':
      return [{ kind: 'staff_deletion_blocked', recipient: { kind: 'staff' } }];
    default:
      return [];
  }
}
