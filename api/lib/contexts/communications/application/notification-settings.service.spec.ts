import { NotificationSettingsService } from './notification-settings.service';
import { NotificationPreferenceRepository } from '../infrastructure/notification-preference.repository';
import { DeviceRepository } from '../infrastructure/device.repository';

function buildService(prisma: any) {
  return new NotificationSettingsService(
    new NotificationPreferenceRepository(prisma),
    new DeviceRepository(prisma),
  );
}

describe('NotificationSettingsService preferences', () => {
  it('serves all-true defaults when no row exists', async () => {
    const prisma = { notificationPreference: { findUnique: vi.fn().mockResolvedValue(null) } };
    const service = buildService(prisma);

    expect(await service.getPreferences('mem_1')).toEqual({
      pushNotifications: true,
      emailNotifications: true,
      bookingReminders: true,
    });
  });

  it('updates each toggle independently: only the present key changes', async () => {
    const upsert = vi.fn().mockResolvedValue({
      pushNotifications: true,
      emailNotifications: false,
      bookingReminders: true,
    });
    const prisma = { notificationPreference: { upsert } };
    const service = buildService(prisma);

    await service.updatePreferences('mem_1', { emailNotifications: false });

    const args = upsert.mock.calls[0][0];
    // The update clause carries ONLY the toggled key, so a stale client
    // saving one switch cannot clobber the others.
    expect(args.update).toEqual({ emailNotifications: false });
    // First-write create seeds the defaults with the change applied.
    expect(args.create).toEqual({
      memberId: 'mem_1',
      pushNotifications: true,
      emailNotifications: false,
      bookingReminders: true,
    });
  });
});

describe('NotificationSettingsService devices', () => {
  it('registers idempotently on the token (re-register refreshes, reassigns owners)', async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: 'dev_1',
      memberId: 'mem_2',
      token: 'tok_abc',
      platform: 'ios',
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
    const prisma = { device: { upsert } };
    const service = buildService(prisma);

    await service.registerDevice('mem_2', 'tok_abc', 'ios');

    const args = upsert.mock.calls[0][0];
    expect(args.where).toEqual({ token: 'tok_abc' });
    // A device that changed hands moves to the new member.
    expect(args.update.memberId).toBe('mem_2');
  });

  it('only removes tokens owned by the caller', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { device: { deleteMany } };
    const service = buildService(prisma);

    const removed = await service.unregisterDevice('mem_1', 'tok_of_someone_else');

    expect(removed).toBe(false);
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: 'tok_of_someone_else', memberId: 'mem_1' } });
  });

  it('purges devices and the preference row on account deletion', async () => {
    const prisma = {
      device: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      notificationPreference: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = buildService(prisma);

    expect(await service.purgeForMember('mem_1')).toEqual({ devicesDeleted: 2 });
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { memberId: 'mem_1' } });
    expect(prisma.notificationPreference.deleteMany).toHaveBeenCalledWith({ where: { memberId: 'mem_1' } });
  });
});
