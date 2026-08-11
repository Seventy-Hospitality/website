// ── Notification preferences + push devices (pure domain data) ──
// Owned by communications: package F's outbox consumers read these to
// decide WHETHER and WHERE to deliver. Each toggle is independent and an
// absent row means all defaults.

export interface NotificationPreferences {
  pushNotifications: boolean;
  emailNotifications: boolean;
  bookingReminders: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  pushNotifications: true,
  emailNotifications: true,
  bookingReminders: true,
};

export const DEVICE_PLATFORMS = ['ios', 'android'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export interface DeviceRecord {
  id: string;
  memberId: string;
  token: string;
  platform: DevicePlatform;
  createdAt: Date;
  lastSeenAt: Date;
}
