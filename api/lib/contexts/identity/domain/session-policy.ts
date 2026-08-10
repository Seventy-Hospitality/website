import type { Client } from './principal';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SessionPolicy {
  idleTtlMs: number;
  absoluteTtlMs: number;
  maxSessions: number;
}

export const SESSION_POLICIES: Record<Client, SessionPolicy> = {
  admin_web: { idleTtlMs: 12 * HOUR, absoluteTtlMs: 30 * DAY, maxSessions: 5 },
  member_mobile: { idleTtlMs: 60 * DAY, absoluteTtlMs: 180 * DAY, maxSessions: 10 },
};

export const ACCESS_TOKEN_TTL_MINUTES = 10;

/** Presenting the rotated-away refresh token within this window is a benign
 * network retry; outside it, a theft signal that revokes the session. */
export const REFRESH_ROTATION_GRACE_MS = 60 * 1000;

export const ACCESS_COOKIE_NAME = 'seventy_access';
export const REFRESH_COOKIE_NAME = 'seventy_refresh';
/** Pre-cutover admin cookie; cleared on sign-out so stale ones disappear. */
export const LEGACY_SESSION_COOKIE_NAME = 'seventy_session';

export interface SessionState {
  revokedAt: Date | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export function isSessionActive(session: SessionState, now = new Date()): boolean {
  return (
    session.revokedAt === null &&
    session.idleExpiresAt > now &&
    session.absoluteExpiresAt > now
  );
}

export function sessionExpiries(
  client: Client,
  now = new Date(),
): { idleExpiresAt: Date; absoluteExpiresAt: Date } {
  const policy = SESSION_POLICIES[client];
  return {
    idleExpiresAt: new Date(now.getTime() + policy.idleTtlMs),
    absoluteExpiresAt: new Date(now.getTime() + policy.absoluteTtlMs),
  };
}

/** The idle window slides on refresh rotation, never past the absolute cap. */
export function extendedIdleExpiry(
  client: Client,
  absoluteExpiresAt: Date,
  now = new Date(),
): Date {
  const slid = now.getTime() + SESSION_POLICIES[client].idleTtlMs;
  return new Date(Math.min(slid, absoluteExpiresAt.getTime()));
}

export function isWithinRotationGrace(rotatedAt: Date | null, now = new Date()): boolean {
  if (!rotatedAt) return false;
  return now.getTime() - rotatedAt.getTime() <= REFRESH_ROTATION_GRACE_MS;
}
