import { randomBytes, createHash } from 'crypto';

// ── Types ──

export interface Session {
  id: string;
  userId: string;
  email: string;
  expiresAt: Date;
  lastActiveAt: Date;
  createdAt: Date;
}

export interface MagicLinkToken {
  id: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
  email: string;
}

// ── Constants ──

export const AUTH_CONSTANTS = {
  SESSION_TTL_DAYS: 30,
  SESSION_IDLE_TIMEOUT_MINUTES: 60 * 24, // 24 hours
  MAGIC_LINK_TTL_MINUTES: 15,
  MAX_SESSIONS_PER_USER: 5,
  SESSION_COOKIE_NAME: 'seventy_session',
} as const;

// ── Domain logic ──

export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  const hash = hashToken(token);
  return { token, hash };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isSessionExpired(session: Session): boolean {
  return session.expiresAt < new Date();
}

export function isSessionIdle(session: Session): boolean {
  const idleLimit = new Date(
    session.lastActiveAt.getTime() + AUTH_CONSTANTS.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000,
  );
  return idleLimit < new Date();
}

export function isSessionValid(session: Session): boolean {
  return !isSessionExpired(session) && !isSessionIdle(session);
}

export function isMagicLinkExpired(token: MagicLinkToken): boolean {
  return token.expiresAt < new Date();
}

export function isMagicLinkUsed(token: MagicLinkToken): boolean {
  return token.usedAt !== null;
}

// ── Errors ──

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class InvalidTokenError extends AuthenticationError {
  constructor() {
    super('Invalid or expired token');
    this.name = 'InvalidTokenError';
  }
}

export class SessionExpiredError extends AuthenticationError {
  constructor() {
    super('Session has expired');
    this.name = 'SessionExpiredError';
  }
}
