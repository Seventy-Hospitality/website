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
  'account-reauth': '',
  'booking-invite': '',
  'booking-rescheduled': '',
  'booking-confirmed': '',
  'booking-cancelled': '',
  'booking-reminder': '',
  'series-booked': '',
  'series-skipped': '',
  'club-invite': '',
  'id-approved': '',
  'id-rejected': '',
  'staff-alert': '',
};

const SUBJECTS: Record<Notification['type'], string> = {
  'magic-link': 'Sign in to Seventy',
  'welcome': 'Welcome to Seventy',
  'payment-failed': 'Payment failed — Seventy Membership',
  'membership-canceled': 'Membership cancellation — Seventy',
  'email-verification': 'Verify your Seventy email',
  'password-reset': 'Reset your Seventy password',
  'account-reauth': 'Confirm it\'s you — Seventy account deletion',
  'booking-invite': 'You\'re invited to a booking at Seventy',
  'booking-rescheduled': 'Your Seventy booking was rescheduled',
  'booking-confirmed': 'Your Seventy booking is confirmed',
  'booking-cancelled': 'Your Seventy booking was cancelled',
  'booking-reminder': 'Reminder: your upcoming Seventy booking',
  'series-booked': 'Your weekly Seventy booking is scheduled',
  'series-skipped': 'Your weekly Seventy booking could not be scheduled',
  'club-invite': 'You\'re invited to a club at Seventy',
  'id-approved': 'Your Seventy ID is verified',
  'id-rejected': 'Your Seventy ID could not be verified',
  'staff-alert': 'Seventy staff alert',
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
    case 'account-reauth':
      return { token: notification.token };
    case 'booking-invite':
      return {
        inviterFirstName: notification.inviterFirstName,
        typeName: notification.typeName,
        date: notification.date,
        timeRange: notification.timeRange,
        reference: notification.reference,
      };
    case 'booking-rescheduled':
    case 'booking-cancelled':
    case 'series-booked':
      return {
        typeName: notification.typeName,
        date: notification.date,
        timeRange: notification.timeRange,
        reference: notification.reference,
      };
    case 'booking-confirmed':
    case 'booking-reminder':
      return {
        firstName: notification.firstName,
        typeName: notification.typeName,
        resourceName: notification.resourceName,
        date: notification.date,
        timeRange: notification.timeRange,
        reference: notification.reference,
      };
    case 'series-skipped':
      return {
        typeName: notification.typeName,
        date: notification.date,
        reason: notification.reason,
      };
    case 'club-invite':
      return { inviterFirstName: notification.inviterFirstName, clubName: notification.clubName };
    case 'id-approved':
      return { firstName: notification.firstName };
    case 'id-rejected':
      return { firstName: notification.firstName, note: notification.note ?? '' };
    case 'staff-alert':
      return { subject: notification.subject, detail: notification.detail };
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
    const subject =
      notification.type === 'staff-alert'
        ? `Seventy staff alert: ${notification.subject}`
        : SUBJECTS[notification.type];

    if (!this.resend) {
      console.log(`[email] ${notification.type} → ${notification.to}`, variables);
      return;
    }

    // The Resend SDK does NOT throw on API-level failures (unverified
    // domain, invalid recipient, rate limit, even network errors): it
    // resolves with an `error` field. Swallowing it would mark the email
    // sent in the delivery ledger and silently drop it forever; throwing
    // keeps the claim pending so the dispatcher retries (retry, never drop).
    const { error } = await this.resend.emails.send({
      from: this.fromAddress,
      to: notification.to,
      subject,
      ...(templateId
        ? { template: { id: templateId, variables } }
        : { html: renderEmail(notification.type, variables) }),
    });
    if (error) {
      throw new Error(`Resend send failed (${error.name}): ${error.message}`);
    }
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

    case 'account-reauth':
      return wrapper(`
<tr><td style="text-align:center;padding-bottom:24px">
  <span style="font-size:${EMAIL.fontTitle};font-weight:600;color:${EMAIL.text}">Confirm it's you</span>
</td></tr>
<tr><td style="text-align:center;padding-bottom:24px;font-size:${EMAIL.fontBody};color:${EMAIL.muted};line-height:1.5">
  You asked to delete your Seventy account. Enter this confirmation code in the app to continue. It expires in 10 minutes. Deleting your account cannot be undone.
</td></tr>
<tr><td style="text-align:center;padding-bottom:32px">
  <span style="display:inline-block;padding:10px 24px;background:${EMAIL.surface};color:${EMAIL.text};font-size:${EMAIL.fontTitle};font-weight:600;letter-spacing:1px;border-radius:${EMAIL.radius};font-family:monospace">
    ${variables.token}
  </span>
</td></tr>
<tr><td style="font-size:12px;color:${EMAIL.muted};line-height:1.4">
  If you didn't request this, someone may have access to your account: change your password and sign out of all devices.
</td></tr>`);

    case 'booking-invite':
      return wrapper(titleAndBody(
        "You're invited",
        `${variables.inviterFirstName} invited you to ${variables.typeName} on ${variables.date}, ${variables.timeRange} (booking ${variables.reference}). Open the Seventy app to accept or decline.`,
      ));

    case 'booking-rescheduled':
      return wrapper(titleAndBody(
        'Booking rescheduled',
        `Booking ${variables.reference} (${variables.typeName}) moved to ${variables.date}, ${variables.timeRange}. Your earlier acceptance no longer applies: open the Seventy app to accept or decline the new time.`,
      ));

    case 'booking-confirmed':
      return wrapper(titleAndBody(
        'Booking confirmed',
        `Hi ${variables.firstName}, your ${variables.typeName} booking is confirmed: ${variables.resourceName}, ${variables.date}, ${variables.timeRange}. Reference ${variables.reference}.`,
      ));

    case 'booking-cancelled':
      return wrapper(titleAndBody(
        'Booking cancelled',
        `Booking ${variables.reference} (${variables.typeName}) on ${variables.date}, ${variables.timeRange} was cancelled.`,
      ));

    case 'booking-reminder':
      return wrapper(titleAndBody(
        'See you soon',
        `Hi ${variables.firstName}, a reminder for your ${variables.typeName} booking: ${variables.resourceName}, ${variables.date}, ${variables.timeRange}. Reference ${variables.reference}.`,
      ));

    case 'series-booked':
      return wrapper(titleAndBody(
        'Weekly booking scheduled',
        `Your weekly ${variables.typeName} booking is scheduled for ${variables.date}, ${variables.timeRange}. Reference ${variables.reference}.`,
      ));

    case 'series-skipped':
      return wrapper(titleAndBody(
        'Weekly booking skipped',
        `Your weekly ${variables.typeName} booking could not be scheduled for ${variables.date} (${variables.reason === 'slot_unavailable' ? 'the slot is already taken' : variables.reason}). Nothing was booked for that date.`,
      ));

    case 'club-invite':
      return wrapper(titleAndBody(
        'Club invitation',
        `${variables.inviterFirstName} invited you to join ${variables.clubName} on Seventy. Open the app to accept or decline.`,
      ));

    case 'id-approved':
      return wrapper(titleAndBody(
        'ID verified',
        `Hi ${variables.firstName}, your identity has been verified. You're all set.`,
      ));

    case 'id-rejected':
      return wrapper(titleAndBody(
        'ID could not be verified',
        `Hi ${variables.firstName}, we could not verify the ID you submitted${variables.note ? ` (${variables.note})` : ''}. Please upload a new photo in the app and submit again.`,
      ));

    case 'staff-alert':
      return wrapper(titleAndBody(
        variables.subject,
        variables.detail,
      ));
  }
}

function titleAndBody(title: string, body: string): string {
  return `
<tr><td style="text-align:center;padding-bottom:24px">
  <span style="font-size:${EMAIL.fontTitle};font-weight:600;color:${EMAIL.text}">${title}</span>
</td></tr>
<tr><td style="font-size:${EMAIL.fontBody};color:${EMAIL.text};line-height:1.5">
  ${body}
</td></tr>`;
}
