import { randomBytes, createHash } from 'crypto';

// ── One-time tokens ──

export type OneTimeTokenPurpose =
  | 'magic_link'
  | 'email_verification'
  | 'password_reset'
  | 'oauth_nonce';

export const TOKEN_TTL_MINUTES: Record<OneTimeTokenPurpose, number> = {
  magic_link: 15,
  email_verification: 60 * 24,
  password_reset: 30,
  oauth_nonce: 10,
};

export interface OneTimeToken {
  id: string;
  purpose: OneTimeTokenPurpose;
  identifier: string;
  tokenHash: string;
  bindingHash: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export function tokenExpiry(purpose: OneTimeTokenPurpose, now = new Date()): Date {
  return new Date(now.getTime() + TOKEN_TTL_MINUTES[purpose] * 60 * 1000);
}

// ── Token generation ──

export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  const hash = hashToken(token);
  return { token, hash };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
