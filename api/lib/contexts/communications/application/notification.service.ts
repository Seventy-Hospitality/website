import {
  magicLinkEmail,
  welcomeEmail,
  paymentFailedEmail,
  membershipCanceledEmail,
} from '../domain';
import type { EmailAdapter } from '../infrastructure/email.adapter';

/**
 * Orchestrates all outbound notifications.
 * Other BCs call this service — they never touch email infrastructure directly.
 */
export class NotificationService {
  constructor(private readonly email: EmailAdapter) {}

  async sendMagicLink(to: string, verifyUrl: string): Promise<void> {
    await this.email.send(magicLinkEmail(to, verifyUrl));
  }

  async sendWelcome(to: string, memberName: string, planName: string): Promise<void> {
    await this.email.send(welcomeEmail(to, memberName, planName));
  }

  async sendPaymentFailed(to: string, memberName: string): Promise<void> {
    await this.email.send(paymentFailedEmail(to, memberName));
  }

  async sendMembershipCanceled(to: string, memberName: string, endsAt: string): Promise<void> {
    await this.email.send(membershipCanceledEmail(to, memberName, endsAt));
  }
}
