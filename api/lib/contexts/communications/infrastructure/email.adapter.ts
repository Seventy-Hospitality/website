import { Resend } from 'resend';
import type { EmailMessage } from '../domain';

/**
 * Concrete email delivery via Resend.
 * This is the only file in the communications BC that touches an external service.
 */
export class EmailAdapter {
  private readonly resend: Resend;
  private readonly fromAddress: string;

  constructor(apiKey: string, fromAddress = 'Seventy <noreply@seventy.club>') {
    this.resend = apiKey ? new Resend(apiKey) : null!;
    this.fromAddress = fromAddress;
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.resend) {
      console.log(`[email] Would send to ${message.to}: ${message.subject}`);
      return;
    }
    await this.resend.emails.send({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
  }
}
