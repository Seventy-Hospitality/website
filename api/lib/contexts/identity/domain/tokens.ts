import { randomBytes, createHash } from 'crypto';

// ── One-time tokens ──

export type OneTimeTokenPurpose =
  | 'magic_link'
  | 'email_verification'
  | 'password_reset'
  | 'oauth_nonce'
  // Step-up re-auth for destructive actions (account deletion). Its own
  // purpose on purpose: a magic-link token is minted by an unauthenticated
  // endpoint whose meaning is "hand the holder a session", and reusing it
  // as deletion proof would let any valid magic link for ANY account
  // satisfy step-up. Reauth tokens are identifier = userId and
  // bindingHash = sha256(sessionId), so they are subject- and
  // session-bound.
  | 'reauth';

export const TOKEN_TTL_MINUTES: Record<OneTimeTokenPurpose, number> = {
  magic_link: 15,
  email_verification: 60 * 24,
  password_reset: 30,
  oauth_nonce: 10,
  reauth: 10,
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
