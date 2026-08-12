/**
 * Notification types — pure domain data describing what to communicate.
 *
 * No HTML, no template IDs, no infrastructure concerns.
 * Each variant defines the data required for that notification.
 */

export type MagicLinkNotification = {
  type: 'magic-link';
  to: string;
  verifyUrl: string;
};

export type WelcomeNotification = {
  type: 'welcome';
  to: string;
  memberName: string;
  planName: string;
};

export type PaymentFailedNotification = {
  type: 'payment-failed';
  to: string;
  memberName: string;
};

export type MembershipCanceledNotification = {
  type: 'membership-canceled';
  to: string;
  memberName: string;
  endsAt: string;
};

export type EmailVerificationNotification = {
  type: 'email-verification';
  to: string;
  verifyUrl: string;
};

export type PasswordResetNotification = {
  type: 'password-reset';
  to: string;
  resetUrl: string;
};

export type AccountReauthNotification = {
  type: 'account-reauth';
  to: string;
  /** Single-use confirmation code the member enters to confirm deletion. */
  token: string;
};

// ── Outbox-driven notifications (package F) ──
// date is the venue-local "YYYY-MM-DD"; timeRange is "HH:MM – HH:MM" venue
// wall clock, both preformatted by the dispatch service.

export type BookingInviteNotification = {
  type: 'booking-invite';
  to: string;
  inviterFirstName: string;
  typeName: string;
  date: string;
  timeRange: string;
  reference: string;
};

export type BookingRescheduledNotification = {
  type: 'booking-rescheduled';
  to: string;
  typeName: string;
  date: string;
  timeRange: string;
  reference: string;
};

export type BookingConfirmedNotification = {
  type: 'booking-confirmed';
  to: string;
  firstName: string;
  typeName: string;
  resourceName: string;
  date: string;
  timeRange: string;
  reference: string;
};

export type BookingCancelledNotification = {
  type: 'booking-cancelled';
  to: string;
  typeName: string;
  date: string;
  timeRange: string;
  reference: string;
};

export type BookingReminderNotification = {
  type: 'booking-reminder';
  to: string;
  firstName: string;
  typeName: string;
  resourceName: string;
  date: string;
  timeRange: string;
  reference: string;
};

export type SeriesBookedNotification = {
  type: 'series-booked';
  to: string;
  typeName: string;
  date: string;
  timeRange: string;
  reference: string;
};

export type SeriesSkippedNotification = {
  type: 'series-skipped';
  to: string;
  typeName: string;
  date: string;
  reason: string;
};

export type ClubInviteNotification = {
  type: 'club-invite';
  to: string;
  inviterFirstName: string;
  clubName: string;
};

export type IdApprovedNotification = {
  type: 'id-approved';
  to: string;
  firstName: string;
};

export type IdRejectedNotification = {
  type: 'id-rejected';
  to: string;
  firstName: string;
  note: string | null;
};

/** Operational alert to the configured staff address (never a member). */
export type StaffAlertNotification = {
  type: 'staff-alert';
  to: string;
  subject: string;
  detail: string;
};

export type Notification =
  | MagicLinkNotification
  | WelcomeNotification
  | PaymentFailedNotification
  | MembershipCanceledNotification
  | EmailVerificationNotification
  | PasswordResetNotification
  | AccountReauthNotification
  | BookingInviteNotification
  | BookingRescheduledNotification
  | BookingConfirmedNotification
  | BookingCancelledNotification
  | BookingReminderNotification
  | SeriesBookedNotification
  | SeriesSkippedNotification
  | ClubInviteNotification
  | IdApprovedNotification
  | IdRejectedNotification
  | StaffAlertNotification;
