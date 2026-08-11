import type { PrismaClient } from '@prisma/client';
import type { NotificationPreferences } from '../domain';

export class NotificationPreferenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getForMember(memberId: string): Promise<NotificationPreferences | null> {
    const row = await this.prisma.notificationPreference.findUnique({
      where: { memberId },
      select: { pushNotifications: true, emailNotifications: true, bookingReminders: true },
    });
    return row;
  }

  /** Upserts only the toggles present, so each switch saves independently. */
  async upsertForMember(
    memberId: string,
    changes: Partial<NotificationPreferences>,
    defaults: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const row = await this.prisma.notificationPreference.upsert({
      where: { memberId },
      create: { memberId, ...defaults, ...changes },
      update: { ...changes },
      select: { pushNotifications: true, emailNotifications: true, bookingReminders: true },
    });
    return row;
  }

  async deleteForMember(memberId: string): Promise<void> {
    await this.prisma.notificationPreference.deleteMany({ where: { memberId } });
  }
}
