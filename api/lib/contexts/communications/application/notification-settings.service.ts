import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type DevicePlatform,
  type DeviceRecord,
  type NotificationPreferences,
} from '../domain';
import type { DeviceRepository } from '../infrastructure/device.repository';
import type { NotificationPreferenceRepository } from '../infrastructure/notification-preference.repository';

/**
 * The member's delivery settings: notification toggles (saved
 * independently, on change) and push-token device registrations.
 * TODO(package-f): the outbox notification consumers read these to gate
 * and target delivery.
 */
export class NotificationSettingsService {
  constructor(
    private readonly preferences: NotificationPreferenceRepository,
    private readonly devices: DeviceRepository,
  ) {}

  async getPreferences(memberId: string): Promise<NotificationPreferences> {
    return (await this.preferences.getForMember(memberId)) ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }

  /** Partial update: only the toggles present change (saved on change). */
  async updatePreferences(
    memberId: string,
    changes: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    return this.preferences.upsertForMember(memberId, changes, DEFAULT_NOTIFICATION_PREFERENCES);
  }

  async registerDevice(memberId: string, token: string, platform: DevicePlatform): Promise<DeviceRecord> {
    return this.devices.register(memberId, token, platform);
  }

  async unregisterDevice(memberId: string, token: string): Promise<boolean> {
    return this.devices.deleteByTokenForMember(memberId, token);
  }

  /**
   * Account-deletion seam: a push token is a live delivery channel and
   * dies with the sessions; the preference row is plain PII-adjacent
   * config with no retention value.
   */
  async purgeForMember(memberId: string): Promise<{ devicesDeleted: number }> {
    const devicesDeleted = await this.devices.deleteAllForMember(memberId);
    await this.preferences.deleteForMember(memberId);
    return { devicesDeleted };
  }
}
