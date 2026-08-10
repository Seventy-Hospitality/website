import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticationService, accountLinkingService, sessionService } from '@/lib/container';
import {
  REFRESH_COOKIE_NAME,
  AccountUnavailableError,
  EmailInUseError,
  IdentityConfigError,
  InvalidCredentialsError,
  InvalidTokenError,
  LinkRejectedError,
  NotAuthorizedError,
  SessionExpiredError,
  type IssuedSession,
  type IdentityUser,
} from '@/lib/contexts/identity';
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

const DEFAULT_ALLOWED_REDIRECT_PREFIXES = [
  'seventy://',
  'exp://',
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'https://127.0.0.1',
  'https://auth.expo.io',
];

const CREDENTIAL_RATE_LIMIT = { max: 10, timeWindow: '15 minutes' } as const;

function getAllowedRedirectPrefixes() {
  const configured = process.env.MOBILE_AUTH_REDIRECT_PREFIXES
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return configured?.length ? configured : DEFAULT_ALLOWED_REDIRECT_PREFIXES;
}

function isAllowedRedirectTo(value: string): boolean {
  return getAllowedRedirectPrefixes().some((prefix) => value.startsWith(prefix));
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

function handleAuthError(reply: FastifyReply, err: unknown) {
  if (err instanceof EmailInUseError) return error(reply, 'EMAIL_IN_USE', err.message, 409);
  if (err instanceof InvalidCredentialsError) return error(reply, 'INVALID_CREDENTIALS', err.message, 401);
  if (err instanceof AccountUnavailableError) return error(reply, 'ACCOUNT_UNAVAILABLE', err.message, 403);
  if (err instanceof LinkRejectedError) {
    const status = err.reason === 'email_required' ? 400 : err.reason === 'account_unavailable' ? 403 : 409;
    return error(reply, 'LINK_REJECTED', err.message, status);
  }
  if (err instanceof InvalidTokenError) return error(reply, 'INVALID_TOKEN', err.message, 401);
  if (err instanceof SessionExpiredError) return error(reply, 'SESSION_EXPIRED', err.message, 401);
  if (err instanceof NotAuthorizedError) return error(reply, 'FORBIDDEN', err.message, 403);
  if (err instanceof IdentityConfigError) return error(reply, 'NOT_CONFIGURED', err.message, 501);
  throw err;
}

export async function authRoutes(app: FastifyInstance) {
  // ── Password ──

  app.post('/signup', {
    config: { rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = signUpSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const issued = await authenticationService.signUp(parsed.data, 'member_mobile', requestMeta(req));
      return success(reply, serializeSession(issued), 201);
    } catch (err) {
      return handleAuthError(reply, err);
    }
  });

  app.post('/signin', {
    config: { rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = signInSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const issued = await authenticationService.signIn(
        parsed.data.email,
        parsed.data.password,
        'member_mobile',
        requestMeta(req),
      );
      return success(reply, serializeSession(issued));
    } catch (err) {
      return handleAuthError(reply, err);
    }
  });

  // ── Native OAuth ──

  app.post('/oauth/nonce', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (_req, reply) => {
    const { nonce, expiresAt } = await accountLinkingService.issueNonce();
    return success(reply, { nonce, expiresAt: expiresAt.toISOString() });
  });

  app.post('/oauth/google', {
    config: { rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = oauthGoogleSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const issued = await accountLinkingService.signInWithGoogle(parsed.data, 'member_mobile', requestMeta(req));
      return success(reply, serializeSession(issued));
    } catch (err) {
      return handleAuthError(reply, err);
    }
  });

  app.post('/oauth/apple', {
    config: { rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = oauthAppleSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const issued = await accountLinkingService.signInWithApple(parsed.data, 'member_mobile', requestMeta(req));
      return success(reply, serializeSession(issued));
    } catch (err) {
      return handleAuthError(reply, err);
    }
  });

  // ── Sessions ──

  app.post('/refresh', async (req, reply) => {
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
      return handleAuthError(reply, err);
    }
  });

  app.post('/signout', async (req, reply) => {
    const user = await authenticateRequest(req, reply).catch(() => null);
    if (user) await sessionService.revoke(user.sessionId, 'signout');
    clearSessionCookies(reply);
    return success(reply, { signedOut: true });
  });

  // Legacy admin-web sign-out; same semantics as /signout.
  app.post('/logout', async (req, reply) => {
    const user = await authenticateRequest(req, reply).catch(() => null);
    if (user) await sessionService.revoke(user.sessionId, 'signout');
    clearSessionCookies(reply);
    return success(reply, { loggedOut: true });
  });

  app.post('/signout-all', async (req, reply) => {
    const user = await authenticateRequest(req, reply).catch(() => null);
    if (!user) return error(reply, 'UNAUTHORIZED', 'Authentication required', 401);

    const revokedSessions = await sessionService.revokeAllForUser(user.userId, 'signout_all');
    clearSessionCookies(reply);
    return success(reply, { signedOut: true, revokedSessions });
  });

  // ── Password reset ──

  app.post('/password/forgot', {
    config: { rateLimit: CREDENTIAL_RATE_LIMIT },
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
    config: { rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      await authenticationService.resetPassword(parsed.data.token, parsed.data.password);
      return success(reply, { reset: true });
    } catch (err) {
      return handleAuthError(reply, err);
    }
  });

  // ── Email verification ──

  app.post('/email/verify', {
    config: { rateLimit: CREDENTIAL_RATE_LIMIT },
  }, async (req, reply) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const result = await authenticationService.verifyEmail(parsed.data.token);
      return success(reply, { verified: true, memberClaimed: result.claimedMemberId !== null });
    } catch (err) {
      return handleAuthError(reply, err);
    }
  });

  app.post('/email/resend', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const user = await authenticateRequest(req, reply).catch(() => null);
    if (!user) return error(reply, 'UNAUTHORIZED', 'Authentication required', 401);

    await authenticationService
      .resendVerification(user.userId)
      .catch((e) => req.log.error(e, 'verification resend failed'));
    return success(reply, { sent: true });
  });

  // ── Magic link (admin web sign-in) ──

  app.post('/magic-link', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const body = sendMagicLinkSchema.safeParse(req.body);
    if (!body.success) {
      return error(reply, 'VALIDATION_ERROR', 'Invalid sign-in request');
    }

    if (body.data.redirectTo && !isAllowedRedirectTo(body.data.redirectTo)) {
      return error(reply, 'VALIDATION_ERROR', 'Unsupported mobile redirect target');
    }

    // Always return success to prevent email enumeration
    await authenticationService.sendMagicLink(body.data.email, {
      redirectTo: body.data.redirectTo,
    }).catch((e) => req.log.error(e, 'magic link send failed'));
    return success(reply, { sent: true });
  });

  // Verify magic link token
  app.get('/verify', async (req, reply) => {
    const query = req.query as { token?: string; redirectTo?: string };
    const redirectTo = query.redirectTo;

    if (redirectTo && !isAllowedRedirectTo(redirectTo)) {
      return error(reply, 'VALIDATION_ERROR', 'Unsupported mobile redirect target');
    }

    if (!query.token) {
      if (redirectTo) {
        return reply.redirect(buildRedirectUrl(redirectTo, { error: 'missing_token' }));
      }
      return reply.redirect(`${authenticationService.getWebUrl()}/sign-in?error=missing_token`);
    }

    try {
      const issued = await authenticationService.verifyMagicLink(
        query.token,
        redirectTo ? 'member_mobile' : 'admin_web',
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
      return reply.redirect(`${authenticationService.getWebUrl()}/members`);
    } catch (e) {
      const errorCode = e instanceof InvalidTokenError ? 'invalid_token' : 'unknown';
      if (redirectTo) {
        return reply.redirect(buildRedirectUrl(redirectTo, { error: errorCode }));
      }
      return reply.redirect(`${authenticationService.getWebUrl()}/sign-in?error=${errorCode}`);
    }
  });

  // Current user — public route, authenticates inline
  app.get('/me', async (req, reply) => {
    const user = await authenticateRequest(req, reply).catch(() => null);
    if (!user) return reply.send({ data: null });

    return reply.send({
      data: {
        userId: user.userId,
        email: user.email,
        staffRole: user.staffRole,
        emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      },
    });
  });
}
