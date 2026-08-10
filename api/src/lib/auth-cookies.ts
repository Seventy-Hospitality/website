import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionService } from '@/lib/container';
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  NotAuthorizedError,
  toAuthenticatedUser,
  type AuthenticatedUser,
  type IssuedSession,
} from '@/lib/contexts/identity';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function setSessionCookies(reply: FastifyReply, issued: IssuedSession): void {
  // Both cookies live as long as the refresh token; the access JWT inside
  // expires after 10 minutes and the auth hook rotates transparently.
  reply.setCookie(ACCESS_COOKIE_NAME, issued.accessToken, {
    ...cookieOptions(),
    expires: issued.refreshTokenExpiresAt,
  });
  reply.setCookie(REFRESH_COOKIE_NAME, issued.refreshToken, {
    ...cookieOptions(),
    expires: issued.refreshTokenExpiresAt,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE_NAME, cookieOptions());
  reply.clearCookie(REFRESH_COOKIE_NAME, cookieOptions());
  reply.clearCookie(LEGACY_SESSION_COOKIE_NAME, cookieOptions());
}

/**
 * Cookie-based authentication for the admin web app: validate the access
 * cookie, and when it has expired rotate the refresh cookie in place so the
 * browser never notices the 10-minute access TTL. Returns null when neither
 * cookie authenticates; NotAuthorizedError (suspended/deleted account)
 * propagates so callers can 403.
 */
export async function authenticateFromCookies(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedUser | null> {
  const accessToken = req.cookies?.[ACCESS_COOKIE_NAME];
  if (accessToken) {
    try {
      return await sessionService.validateAccessToken(accessToken);
    } catch (err) {
      if (err instanceof NotAuthorizedError) throw err;
      // Expired or invalid access token: fall through to the refresh cookie.
    }
  }

  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!refreshToken) return null;

  try {
    const issued = await sessionService.refresh(refreshToken);
    setSessionCookies(reply, issued);
    return toAuthenticatedUser(issued);
  } catch (err) {
    if (err instanceof NotAuthorizedError) throw err;
    return null;
  }
}

/** Bearer token when present, cookies otherwise. */
export async function authenticateRequest(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedUser | null> {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (bearer) {
    try {
      return await sessionService.validateAccessToken(bearer);
    } catch (err) {
      if (err instanceof NotAuthorizedError) throw err;
      return null;
    }
  }
  return authenticateFromCookies(req, reply);
}
