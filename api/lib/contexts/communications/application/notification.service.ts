import type { Notification } from '../domain/notifications';
import type { NotificationSender } from './ports';

/**
 * Orchestrates all outbound notifications.
 * Other BCs call this service — they never touch infrastructure directly.
 */
export class NotificationService {
  constructor(private readonly sender: NotificationSender) {}

  async sendMagicLink(to: string, verifyUrl: string): Promise<void> {
    await this.sender.send({ type: 'magic-link', to, verifyUrl });
  }

  async sendWelcome(to: string, memberName: string, planName: string): Promise<void> {
    await this.sender.send({ type: 'welcome', to, memberName, planName });
  }

  async sendPaymentFailed(to: string, memberName: string): Promise<void> {
    await this.sender.send({ type: 'payment-failed', to, memberName });
  }

  async sendMembershipCanceled(to: string, memberName: string, endsAt: string): Promise<void> {
    await this.sender.send({ type: 'membership-canceled', to, memberName, endsAt });
  }

  async sendEmailVerification(to: string, verifyUrl: string): Promise<void> {
    await this.sender.send({ type: 'email-verification', to, verifyUrl });
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    await this.sender.send({ type: 'password-reset', to, resetUrl });
  }

  /** Step-up re-auth code for destructive account actions (deletion). */
  async sendAccountReauth(to: string, token: string): Promise<void> {
    await this.sender.send({ type: 'account-reauth', to, token });
  }
}
