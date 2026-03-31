import { NotificationService } from './notification.service';
import type { NotificationSender } from './ports';

function mockSender(): NotificationSender {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  };
}

describe('NotificationService', () => {
  describe('sendMagicLink', () => {
    it('sends a magic-link notification', async () => {
      const sender = mockSender();
      const service = new NotificationService(sender);

      await service.sendMagicLink('user@example.com', 'https://app.com/verify?token=abc');

      expect(sender.send).toHaveBeenCalledOnce();
      expect(sender.send).toHaveBeenCalledWith({
        type: 'magic-link',
        to: 'user@example.com',
        verifyUrl: 'https://app.com/verify?token=abc',
      });
    });
  });

  describe('sendWelcome', () => {
    it('sends a welcome notification', async () => {
      const sender = mockSender();
      const service = new NotificationService(sender);

      await service.sendWelcome('user@example.com', 'Jane Doe', 'Monthly');

      expect(sender.send).toHaveBeenCalledOnce();
      expect(sender.send).toHaveBeenCalledWith({
        type: 'welcome',
        to: 'user@example.com',
        memberName: 'Jane Doe',
        planName: 'Monthly',
      });
    });
  });

  describe('sendPaymentFailed', () => {
    it('sends a payment-failed notification', async () => {
      const sender = mockSender();
      const service = new NotificationService(sender);

      await service.sendPaymentFailed('user@example.com', 'Jane Doe');

      expect(sender.send).toHaveBeenCalledOnce();
      expect(sender.send).toHaveBeenCalledWith({
        type: 'payment-failed',
        to: 'user@example.com',
        memberName: 'Jane Doe',
      });
    });
  });

  describe('sendMembershipCanceled', () => {
    it('sends a membership-canceled notification', async () => {
      const sender = mockSender();
      const service = new NotificationService(sender);

      await service.sendMembershipCanceled('user@example.com', 'Jane Doe', '2025-12-31');

      expect(sender.send).toHaveBeenCalledOnce();
      expect(sender.send).toHaveBeenCalledWith({
        type: 'membership-canceled',
        to: 'user@example.com',
        memberName: 'Jane Doe',
        endsAt: '2025-12-31',
      });
    });
  });

  it('propagates sender errors', async () => {
    const sender = mockSender();
    (sender.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('send failed'));

    const service = new NotificationService(sender);
    await expect(service.sendMagicLink('user@example.com', 'https://app.com/verify')).rejects.toThrow('send failed');
  });
});
