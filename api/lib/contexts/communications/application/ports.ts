import type { Notification } from '../domain/notifications';

/**
 * Port for sending notifications.
 * Infrastructure adapters implement this to deliver via email, push, SMS, etc.
 */
export interface NotificationSender {
  send(notification: Notification): Promise<void>;
}
