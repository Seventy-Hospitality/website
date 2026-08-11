import type { PrismaClient } from '@prisma/client';
import type { DevicePlatform, DeviceRecord } from '../domain';

export class DeviceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Idempotent register keyed on the globally-unique token: re-registering
   * refreshes lastSeenAt, and a device that changed hands moves to its new
   * member (one push target per physical device).
   */
  async register(memberId: string, token: string, platform: DevicePlatform, now: Date = new Date()): Promise<DeviceRecord> {
    return this.prisma.device.upsert({
      where: { token },
      create: { memberId, token, platform, lastSeenAt: now },
      update: { memberId, platform, lastSeenAt: now },
      select: { id: true, memberId: true, token: true, platform: true, createdAt: true, lastSeenAt: true },
    }) as Promise<DeviceRecord>;
  }

  /** Scoped to the owner: nobody can unregister another member's token. */
  async deleteByTokenForMember(memberId: string, token: string): Promise<boolean> {
    const result = await this.prisma.device.deleteMany({ where: { token, memberId } });
    return result.count > 0;
  }

  async listForMember(memberId: string): Promise<DeviceRecord[]> {
    return this.prisma.device.findMany({
      where: { memberId },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, memberId: true, token: true, platform: true, createdAt: true, lastSeenAt: true },
    }) as Promise<DeviceRecord[]>;
  }

  async deleteAllForMember(memberId: string): Promise<number> {
    const result = await this.prisma.device.deleteMany({ where: { memberId } });
    return result.count;
  }
}
