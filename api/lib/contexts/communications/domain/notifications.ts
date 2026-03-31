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

export type Notification =
  | MagicLinkNotification
  | WelcomeNotification
  | PaymentFailedNotification
  | MembershipCanceledNotification;
