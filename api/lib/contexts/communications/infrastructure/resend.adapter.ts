import { Resend } from 'resend';
import type { Notification } from '../domain/notifications';
import type { NotificationSender } from '../application/ports';

/**
 * Resend template-based email delivery.
 *
 * Maps domain notification types to Resend template IDs.
 * Templates are designed in Resend's dashboard — no HTML in code.
 *
 * When RESEND_API_KEY is missing (local dev), logs to console instead.
 */

/**
 * Map notification type → Resend template ID.
 * Set these after creating templates in the Resend dashboard.
 */
const TEMPLATE_IDS: Record<Notification['type'], string> = {
  'magic-link': '',
  'welcome': '',
  'payment-failed': '',
  'membership-canceled': '',
};

const SUBJECTS: Record<Notification['type'], string> = {
  'magic-link': 'Sign in to Seventy',
  'welcome': 'Welcome to Seventy',
  'payment-failed': 'Payment failed — Seventy Membership',
  'membership-canceled': 'Membership cancellation — Seventy',
};

function getVariables(notification: Notification): Record<string, string> {
  switch (notification.type) {
    case 'magic-link':
      return { verifyUrl: notification.verifyUrl };
    case 'welcome':
      return { memberName: notification.memberName, planName: notification.planName };
    case 'payment-failed':
      return { memberName: notification.memberName };
    case 'membership-canceled':
      return { memberName: notification.memberName, endsAt: notification.endsAt };
  }
}

export class ResendAdapter implements NotificationSender {
  private readonly resend: Resend | null;
  private readonly fromAddress: string;

  constructor(apiKey: string, fromAddress = 'Seventy <noreply@seventy.club>') {
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.fromAddress = fromAddress;
  }

  async send(notification: Notification): Promise<void> {
    const variables = getVariables(notification);
    const templateId = TEMPLATE_IDS[notification.type];
    const subject = SUBJECTS[notification.type];

    if (!this.resend) {
      console.log(`[email] ${notification.type} → ${notification.to}`, variables);
      return;
    }

    await this.resend.emails.send({
      from: this.fromAddress,
      to: notification.to,
      subject,
      ...(templateId
        ? { template: { id: templateId, variables } }
        : { html: plainTextFallback(notification.type, variables) }),
    });
  }
}

/** Dev/fallback: minimal HTML until templates are set up in Resend dashboard. */
function plainTextFallback(type: string, variables: Record<string, string>): string {
  const vars = Object.entries(variables)
    .map(([k, v]) => `<strong>${k}:</strong> ${v}`)
    .join('<br>');
  return `<p>[${type}]</p><p>${vars}</p>`;
}
