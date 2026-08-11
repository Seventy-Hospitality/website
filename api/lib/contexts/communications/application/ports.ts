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
