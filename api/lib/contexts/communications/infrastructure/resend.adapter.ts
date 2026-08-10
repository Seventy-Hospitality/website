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
  'email-verification': '',
  'password-reset': '',
};

const SUBJECTS: Record<Notification['type'], string> = {
  'magic-link': 'Sign in to Seventy',
  'welcome': 'Welcome to Seventy',
  'payment-failed': 'Payment failed — Seventy Membership',
  'membership-canceled': 'Membership cancellation — Seventy',
  'email-verification': 'Verify your Seventy email',
  'password-reset': 'Reset your Seventy password',
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
    case 'email-verification':
      return { verifyUrl: notification.verifyUrl };
    case 'password-reset':
      return { resetUrl: notification.resetUrl };
  }
}

export class ResendAdapter implements NotificationSender {
  private readonly resend: Resend | null;
  private readonly fromAddress: string;

  constructor(apiKey: string, fromAddress = 'Seventy <noreply@seventyhospitality.com>') {
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
        : { html: renderEmail(notification.type, variables) }),
    });
  }
}

/** Dev/fallback: minimal HTML until templates are set up in Resend dashboard. */
/**
 * Email color tokens — mirrors the octahedron design system.
 * Email clients can't use CSS variables, so we hardcode the light-theme values.
 */
const EMAIL = {
  brand: '#4a7c59',       // --octa-brand
  text: '#111827',        // --octa-text (light)
  muted: '#4b5563',       // --octa-muted (light)
  surface: '#f3f4f6',     // --octa-surface (light)
  bg: '#ffffff',          // --octa-bg-app (light)
  border: '#d1d5db',      // --octa-border (light)
  radius: '6px',          // --octa-control-radius
  fontBody: '13px',       // --octa-font-size-body
  fontTitle: '18px',      // --octa-font-size-title
  fontStack: "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
} as const;

function renderEmail(type: Notification['type'], variables: Record<string, string>): string {
  const wrapper = (content: string) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${EMAIL.surface};font-family:${EMAIL.fontStack}">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:400px;background:${EMAIL.bg};border:1px solid ${EMAIL.border};border-radius:${EMAIL.radius};padding:40px">
${content}
</table>
<p style="margin-top:24px;font-size:12px;color:${EMAIL.muted}">Seventy Badminton Club</p>
</td></tr>
</table>
</body>
</html>`;

  switch (type) {
    case 'magic-link':
      return wrapper(`
<tr><td style="text-align:center;padding-bottom:24px">
  <span style="font-size:${EMAIL.fontTitle};font-weight:600;color:${EMAIL.text}">Sign in to Seventy</span>
</td></tr>
<tr><td style="text-align:center;padding-bottom:32px;font-size:${EMAIL.fontBody};color:${EMAIL.muted};line-height:1.5">
  Click the button below to sign in. This link expires in 15 minutes.
</td></tr>
<tr><td style="text-align:center;padding-bottom:32px">
  <a href="${variables.verifyUrl}" style="display:inline-block;padding:10px 24px;background:${EMAIL.brand};color:#ffffff;font-size:${EMAIL.fontBody};font-weight:500;text-decoration:none;border-radius:${EMAIL.radius}">
    Sign in
  </a>
</td></tr>
<tr><td style="font-size:12px;color:${EMAIL.muted};line-height:1.4">
  If you didn't request this, you can ignore this email.
</td></tr>`);

    case 'welcome':
      return wrapper(`
<tr><td style="text-align:center;padding-bottom:24px">
  <span style="font-size:${EMAIL.fontTitle};font-weight:600;color:${EMAIL.text}">Welcome to Seventy</span>
</td></tr>
<tr><td style="font-size:${EMAIL.fontBody};color:${EMAIL.text};line-height:1.5">
  Hi ${variables.memberName}, welcome to Seventy Badminton Club! Your ${variables.planName} membership is now active.
</td></tr>`);

    case 'payment-failed':
      return wrapper(`
<tr><td style="text-align:center;padding-bottom:24px">
  <span style="font-size:${EMAIL.fontTitle};font-weight:600;color:${EMAIL.text}">Payment Failed</span>
</td></tr>
<tr><td style="font-size:${EMAIL.fontBody};color:${EMAIL.text};line-height:1.5">
  Hi ${variables.memberName}, we were unable to process your membership payment. Please update your payment method to avoid interruption.
</td></tr>`);

    case 'membership-canceled':
      return wrapper(`
<tr><td style="text-align:center;padding-bottom:24px">
  <span style="font-size:${EMAIL.fontTitle};font-weight:600;color:${EMAIL.text}">Membership Canceled</span>
</td></tr>
<tr><td style="font-size:${EMAIL.fontBody};color:${EMAIL.text};line-height:1.5">
  Hi ${variables.memberName}, your membership has been canceled. You'll have access until ${variables.endsAt}.
</td></tr>`);

    case 'email-verification':
      return wrapper(`
<tr><td style="text-align:center;padding-bottom:24px">
  <span style="font-size:${EMAIL.fontTitle};font-weight:600;color:${EMAIL.text}">Verify your email</span>
</td></tr>
<tr><td style="text-align:center;padding-bottom:32px;font-size:${EMAIL.fontBody};color:${EMAIL.muted};line-height:1.5">
  Confirm this email address to finish setting up your account. This link expires in 24 hours.
</td></tr>
<tr><td style="text-align:center;padding-bottom:32px">
  <a href="${variables.verifyUrl}" style="display:inline-block;padding:10px 24px;background:${EMAIL.brand};color:#ffffff;font-size:${EMAIL.fontBody};font-weight:500;text-decoration:none;border-radius:${EMAIL.radius}">
    Verify email
  </a>
</td></tr>
<tr><td style="font-size:12px;color:${EMAIL.muted};line-height:1.4">
  If you didn't create an account, you can ignore this email.
</td></tr>`);

    case 'password-reset':
      return wrapper(`
<tr><td style="text-align:center;padding-bottom:24px">
  <span style="font-size:${EMAIL.fontTitle};font-weight:600;color:${EMAIL.text}">Reset your password</span>
</td></tr>
<tr><td style="text-align:center;padding-bottom:32px;font-size:${EMAIL.fontBody};color:${EMAIL.muted};line-height:1.5">
  Click the button below to choose a new password. This link expires in 30 minutes.
</td></tr>
<tr><td style="text-align:center;padding-bottom:32px">
  <a href="${variables.resetUrl}" style="display:inline-block;padding:10px 24px;background:${EMAIL.brand};color:#ffffff;font-size:${EMAIL.fontBody};font-weight:500;text-decoration:none;border-radius:${EMAIL.radius}">
    Reset password
  </a>
</td></tr>
<tr><td style="font-size:12px;color:${EMAIL.muted};line-height:1.4">
  If you didn't request this, you can ignore this email and your password will stay the same.
</td></tr>`);
  }
}
