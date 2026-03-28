/**
 * Email template definitions. Domain knowledge about what to communicate.
 * No infrastructure imports — templates are pure data.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export function magicLinkEmail(to: string, verifyUrl: string): EmailMessage {
  return {
    to,
    subject: 'Sign in to Seventy',
    html: `
      <h2>Sign in to Seventy</h2>
      <p>Click the link below to sign in. This link expires in 15 minutes.</p>
      <p><a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#22d3a7;color:#fff;text-decoration:none;border-radius:6px;">Sign In</a></p>
      <p>Or copy this link: ${verifyUrl}</p>
      <p style="color:#666;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
    `,
  };
}

export function welcomeEmail(to: string, memberName: string, planName: string): EmailMessage {
  return {
    to,
    subject: 'Welcome to Seventy',
    html: `
      <h2>Welcome to Seventy, ${memberName}!</h2>
      <p>Your <strong>${planName}</strong> membership is now active.</p>
      <p>See you on the court.</p>
    `,
  };
}

export function paymentFailedEmail(to: string, memberName: string): EmailMessage {
  return {
    to,
    subject: 'Payment failed — Seventy Membership',
    html: `
      <h2>Payment issue</h2>
      <p>Hi ${memberName}, we weren't able to process your membership payment.</p>
      <p>Please update your payment method to keep your membership active.</p>
      <p style="color:#666;font-size:12px;">If you believe this is an error, contact us.</p>
    `,
  };
}

export function membershipCanceledEmail(to: string, memberName: string, endsAt: string): EmailMessage {
  return {
    to,
    subject: 'Membership cancellation — Seventy',
    html: `
      <h2>Membership canceled</h2>
      <p>Hi ${memberName}, your membership has been canceled and will remain active until ${endsAt}.</p>
      <p>You're welcome back anytime.</p>
    `,
  };
}
