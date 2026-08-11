import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticationService, accountLinkingService, sessionService } from '@/lib/container';
import {
  REFRESH_COOKIE_NAME,
  InvalidTokenError,
  type Client,
  type IssuedSession,
  type IdentityUser,
} from '@/lib/contexts/identity';
import { handleIdentityError } from '@/src/lib/identity-errors';
import { error, success } from '@/src/lib/responses';
import {
  forgotPasswordSchema,
  oauthAppleSchema,
  oauthGoogleSchema,
  refreshSchema,
  resetPasswordSchema,
  sendMagicLinkSchema,
  signInSchema,
  signUpSchema,
  verifyEmailSchema,
} from '@/src/lib/validation';
import {
  authenticateRequest,
  clearSessionCookies,
  setSessionCookies,
} from '@/src/lib/auth-cookies';

// Redirect targets for the native-app magic-link flow. Custom schemes
// (`seventy:`, `exp:`) are matched by scheme alone — the OS routes them to the
// app that registered the scheme, so any host/path under one is the app
// itself. http(s) entries are matched by scheme + exact hostname (any port, so
// dev servers on arbitrary localhost ports work). Matching is exact, NOT a
// string prefix: a prefix check let `https://auth.expo.io.attacker.tld` and
// `https://auth.expo.io@attacker.tld` through and exfiltrated the session to
// the attacker's host.
const DEFAULT_ALLOWED_REDIRECT_TARGETS = [
  'seventy:',
  'exp:',
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'https://127.0.0.1',
  'https://auth.expo.io',
];

const CREDENTIAL_RATE_LIMIT = { max: 10, timeWindow: '15 minutes' } as const;

function getAllowedRedirectTargets() {
  const configured = process.env.MOBILE_AUTH_REDIRECT_TARGETS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return configured?.length ? configured : DEFAULT_ALLOWED_REDIRECT_TARGETS;
}

function isAllowedRedirectTo(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Embedded credentials (`https://auth.expo.io@attacker.tld`) resolve the host
  // to the attacker; reject them outright.
  if (url.username || url.password) return false;

  return getAllowedRedirectTargets().some((target) => {
    if (target.endsWith(':')) {
      // Custom scheme, e.g. `seventy:`.
      return url.protocol === target;
    }
    let allowed: URL;
    try {
      allowed = new URL(target);
    } catch {
      return false;
    }
    return url.protocol === allowed.protocol && url.hostname === allowed.hostname;
  });
}

function buildRedirectUrl(redirectTo: string, params: Record<string, string>) {
  const url = new URL(redirectTo);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function serializeUser(user: IdentityUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    staffRole: user.staffRole,
  };
}

function serializeSession(issued: IssuedSession) {
  return {
    user: serializeUser(issued.user),
    accessToken: issued.accessToken,
    accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
    refreshToken: issued.refreshToken,
    refreshTokenExpiresAt: issued.refreshTokenExpiresAt.toISOString(),
  };
}

function requestMeta(req: FastifyRequest) {
  return { ip: req.ip ?? null };
}

/**
 * Which member client is signing in, from the explicit `X-Client-Type`
 * header: `web` selects the cookie-transport `member_web` client, `mobile`
 * the bearer `member_mobile` one. No header means mobile, preserving the
 * deployed native app, which predates the header. Anything else is a caller
 * bug; routes reject it rather than guessing a transport.
 */
function memberClientFromHeader(req: FastifyRequest): Client | null {
  const raw = req.headers['x-client-type'];
  if (raw === undefined) return 'member_mobile';
  if (typeof raw !== 'string') return null;

  const value = raw.trim().toLowerCase();
  if (value === 'mobile') return 'member_mobile';
  if (value === 'web') return 'member_web';
  return null;
}

const UNSUPPORTED_CLIENT_TYPE = 'X-Client-Type must be "web" or "mobile"';

/**
 * Web clients get httpOnly cookies and a token-free body (same contract as
 * the cookie branch of /refresh); mobile clients get the bearer token pair.
 */
function respondWithSession(reply: FastifyReply, issued: IssuedSession, status = 200) {
  if (issued.client === 'member_web') {
    setSessionCookies(reply, issued);
    return success(
      reply,
      {
        user: serializeUser(issued.user),
        accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
      },
      status,
    );
  }
  return success(reply, serializeSession(issued), status);
}

export async function authRoutes(app: FastifyInstance) {
  // ── Password ──

  app.post('/signup', {
    config: { policy: 'public', rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const client = memberClientFromHeader(req);
    if (!client) return error(reply, 'VALIDATION_ERROR', UNSUPPORTED_CLIENT_TYPE);

    const parsed = signUpSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const issued = await authenticationService.signUp(parsed.data, client, requestMeta(req));
      return respondWithSession(reply, issued, 201);
    } catch (err) {
      return handleIdentityError(reply, err);
    }
  });

  app.post('/signin', {
    config: { policy: 'public', rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const client = memberClientFromHeader(req);
    if (!client) return error(reply, 'VALIDATION_ERROR', UNSUPPORTED_CLIENT_TYPE);

    const parsed = signInSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const issued = await authenticationService.signIn(
        parsed.data.email,
        parsed.data.password,
        client,
        requestMeta(req),
      );
      return respondWithSession(reply, issued);
    } catch (err) {
      return handleIdentityError(reply, err);
    }
  });

  // ── Native OAuth ──

  app.post('/oauth/nonce', {
    config: { policy: 'public', rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (_req, reply) => {
    const { nonce, expiresAt } = await accountLinkingService.issueNonce();
    return success(reply, { nonce, expiresAt: expiresAt.toISOString() });
  });

  app.post('/oauth/google', {
    config: { policy: 'public', rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const client = memberClientFromHeader(req);
    if (!client) return error(reply, 'VALIDATION_ERROR', UNSUPPORTED_CLIENT_TYPE);

    const parsed = oauthGoogleSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const issued = await accountLinkingService.signInWithGoogle(parsed.data, client, requestMeta(req));
      return respondWithSession(reply, issued);
    } catch (err) {
      return handleIdentityError(reply, err);
    }
  });

  app.post('/oauth/apple', {
    config: { policy: 'public', rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const client = memberClientFromHeader(req);
    if (!client) return error(reply, 'VALIDATION_ERROR', UNSUPPORTED_CLIENT_TYPE);

    const parsed = oauthAppleSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const issued = await accountLinkingService.signInWithApple(parsed.data, client, requestMeta(req));
      return respondWithSession(reply, issued);
    } catch (err) {
      return handleIdentityError(reply, err);
    }
  });

  // ── Sessions ──

  app.post('/refresh', { config: { policy: 'public' } }, async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body ?? {});
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const cookieToken = req.cookies?.[REFRESH_COOKIE_NAME];
    const token = parsed.data.refreshToken ?? cookieToken;
    if (!token) return error(reply, 'VALIDATION_ERROR', 'refreshToken is required');

    try {
      const issued = await sessionService.refresh(token);
      if (!parsed.data.refreshToken) {
        // Cookie client: tokens stay in httpOnly cookies, never in the body.
        setSessionCookies(reply, issued);
        return success(reply, {
          user: serializeUser(issued.user),
          accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
        });
      }
      return success(reply, serializeSession(issued));
    } catch (err) {
      return handleIdentityError(reply, err);
    }
  });

  app.post('/signout', { config: { policy: 'authenticated' } }, async (req, reply) => {
    await sessionService.revoke(req.principal!.sessionId, 'signout');
    clearSessionCookies(reply);
    return success(reply, { signedOut: true });
  });

  // Legacy admin-web sign-out; same semantics as /signout.
  app.post('/logout', { config: { policy: 'authenticated' } }, async (req, reply) => {
    await sessionService.revoke(req.principal!.sessionId, 'signout');
    clearSessionCookies(reply);
    return success(reply, { loggedOut: true });
  });

  app.post('/signout-all', { config: { policy: 'authenticated' } }, async (req, reply) => {
    const revokedSessions = await sessionService.revokeAllForUser(req.principal!.userId, 'signout_all');
    clearSessionCookies(reply);
    return success(reply, { signedOut: true, revokedSessions });
  });

  // ── Password reset ──

  app.post('/password/forgot', {
    config: { policy: 'public', rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    // Always return success to prevent email enumeration
    await authenticationService
      .requestPasswordReset(parsed.data.email)
      .catch((e) => req.log.error(e, 'password reset send failed'));
    return success(reply, { sent: true });
  });

  app.post('/password/reset', {
    config: { policy: 'public', rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      await authenticationService.resetPassword(parsed.data.token, parsed.data.password);
      return success(reply, { reset: true });
    } catch (err) {
      return handleIdentityError(reply, err);
    }
  });

  // ── Email verification ──

  app.post('/email/verify', {
    config: { policy: 'public', rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const result = await authenticationService.verifyEmail(parsed.data.token);
      return success(reply, { verified: true, memberClaimed: result.claimedMemberId !== null });
    } catch (err) {
      return handleIdentityError(reply, err);
    }
  });

  app.post('/email/resend', {
    config: { policy: 'authenticated', rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    await authenticationService
      .resendVerification(req.principal!.userId)
      .catch((e) => req.log.error(e, 'verification resend failed'));
    return success(reply, { sent: true });
  });

  // ── Magic link (admin web sign-in + member recovery, web and mobile) ──

  app.post('/magic-link', {
    config: { policy: 'public', rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const client = memberClientFromHeader(req);
    if (!client) return error(reply, 'VALIDATION_ERROR', UNSUPPORTED_CLIENT_TYPE);

    const body = sendMagicLinkSchema.safeParse(req.body);
    if (!body.success) {
      return error(reply, 'VALIDATION_ERROR', 'Invalid sign-in request');
    }

    // redirectTo is the native deep-link flow; a web caller gets cookies from
    // /verify instead, so combining the two signals is a caller bug.
    if (client === 'member_web' && body.data.redirectTo) {
      return error(reply, 'VALIDATION_ERROR', 'redirectTo is not supported for web clients');
    }

    if (body.data.redirectTo && !isAllowedRedirectTo(body.data.redirectTo)) {
      return error(reply, 'VALIDATION_ERROR', 'Unsupported mobile redirect target');
    }

    // Always return success to prevent email enumeration
    await authenticationService.sendMagicLink(body.data.email, {
      redirectTo: body.data.redirectTo,
      client: client === 'member_web' ? 'member_web' : undefined,
    }).catch((e) => req.log.error(e, 'magic link send failed'));
    return success(reply, { sent: true });
  });

  // Verify magic link token. Three flows, decided by how /magic-link minted
  // the link: `redirectTo` -> native deep link carrying body tokens;
  // `client=member_web` -> member web cookies, landing on the member app at
  // `/`; neither -> admin web cookies, landing on the admin app at `/admin`.
  app.get('/verify', { config: { policy: 'public' } }, async (req, reply) => {
    const query = req.query as { token?: string; redirectTo?: string; client?: string };
    const redirectTo = query.redirectTo;

    if (redirectTo && !isAllowedRedirectTo(redirectTo)) {
      return error(reply, 'VALIDATION_ERROR', 'Unsupported mobile redirect target');
    }
    if (query.client !== undefined && query.client !== 'member_web') {
      return error(reply, 'VALIDATION_ERROR', 'Unsupported client');
    }
    if (redirectTo && query.client) {
      return error(reply, 'VALIDATION_ERROR', 'redirectTo and client are mutually exclusive');
    }

    const webClient: Client = query.client === 'member_web' ? 'member_web' : 'admin_web';
    const webBase = authenticationService.getWebUrl();
    const signInUrl = webClient === 'member_web' ? `${webBase}/sign-in` : `${webBase}/admin/sign-in`;
    const landingUrl = webClient === 'member_web' ? `${webBase}/` : `${webBase}/admin/members`;

    if (!query.token) {
      if (redirectTo) {
        return reply.redirect(buildRedirectUrl(redirectTo, { error: 'missing_token' }));
      }
      return reply.redirect(`${signInUrl}?error=missing_token`);
    }

    try {
      const issued = await authenticationService.verifyMagicLink(
        query.token,
        redirectTo ? 'member_mobile' : webClient,
        requestMeta(req),
      );

      if (redirectTo) {
        return reply.redirect(
          buildRedirectUrl(redirectTo, {
            token: issued.accessToken,
            refreshToken: issued.refreshToken,
            expiresAt: issued.accessTokenExpiresAt.toISOString(),
          }),
        );
      }

      setSessionCookies(reply, issued);
      return reply.redirect(landingUrl);
    } catch (e) {
      const errorCode = e instanceof InvalidTokenError ? 'invalid_token' : 'unknown';
      if (redirectTo) {
        return reply.redirect(buildRedirectUrl(redirectTo, { error: errorCode }));
      }
      return reply.redirect(`${signInUrl}?error=${errorCode}`);
    }
  });

  // Current principal, or null — public so the app can ask "am I signed in?"
  app.get('/me', { config: { policy: 'public' } }, async (req, reply) => {
    const principal = await authenticateRequest(req, reply).catch(() => null);
    if (!principal) return reply.send({ data: null });

    return reply.send({
      data: {
        userId: principal.userId,
        email: principal.email,
        emailVerified: principal.emailVerified,
        staffRole: principal.staffRole,
        memberId: principal.memberId,
        client: principal.client,
      },
    });
  });
}
