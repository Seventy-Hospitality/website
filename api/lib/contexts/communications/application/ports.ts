import type { Notification } from '../domain/notifications';

/**
 * Port for sending notifications.
 * Infrastructure adapters implement this to deliver via email, push, SMS, etc.
 */
export interface NotificationSender {
  send(notification: Notification): Promise<void>;
}

/** One push message addressed to a registered device token. */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** Deep-link payload for the mobile client (reservation id, club id, ...). */
  data?: Record<string, unknown>;
}

/**
 * Port for push delivery. The Expo adapter implements it; without a
 * configured credential it logs instead of sending, exactly as the Resend
 * adapter degrades without RESEND_API_KEY (decision + persistence logic
 * stay real either way; only the external call is config-gated).
 */
export interface PushSender {
  send(messages: PushMessage[]): Promise<void>;
}

// ── Resolution ports for the outbox consumer (package F) ──
// The dispatcher lives in communications and reaches the OTHER contexts
// only through these narrow read ports, wired in the container over their
// public barrels.

export interface RecipientContact {
  memberId: string;
  email: string;
  firstName: string;
}

/** Members context: resolve a live (non-deleted) recipient's contact. */
export interface RecipientDirectory {
  getContact(memberId: string): Promise<RecipientContact | null>;
}

/** Bookings context: everything a booking notification needs to render. */
export interface ReservationNotificationView {
  id: string;
  reference: string;
  typeName: string;
  resourceName: string;
  localDate: string;
  startsAt: Date;
  endsAt: Date;
  organizerId: string;
  seriesId: string | null;
  participants: Array<{ memberId: string; role: string; status: string }>;
}

export interface ReservationDirectory {
  getNotificationView(reservationId: string): Promise<ReservationNotificationView | null>;
}

/** Clubs context: club name + invitation graph for club notifications. */
export interface ClubInvitationNotificationView {
  invitationId: string;
  clubId: string;
  clubName: string;
  inviterMemberId: string | null;
  inviteeMemberId: string;
}

export interface ClubDirectory {
  getClubName(clubId: string): Promise<string | null>;
  getInvitationView(invitationId: string): Promise<ClubInvitationNotificationView | null>;
}
