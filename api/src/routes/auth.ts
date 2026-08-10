import type { FastifyInstance } from 'fastify';
import { authService } from '@/lib/container';
import { AUTH_CONSTANTS, InvalidTokenError } from '@/lib/contexts/auth';
import { error, success } from '@/src/lib/responses';
import { sendMagicLinkSchema } from '@/src/lib/validation';

const DEFAULT_ALLOWED_REDIRECT_PREFIXES = [
  'seventy://',
  'exp://',
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'https://127.0.0.1',
  'https://auth.expo.io',
];

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

export async function authRoutes(app: FastifyInstance) {
  // Send magic link
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
    await authService.sendMagicLink(body.data.email, {
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
      return reply.redirect(`${authService.getWebUrl()}/sign-in?error=missing_token`);
    }

    try {
      const { jwt, expiresAt } = await authService.verifyMagicLink(query.token);

      if (redirectTo) {
        return reply.redirect(
          buildRedirectUrl(redirectTo, {
            token: jwt,
            expiresAt: expiresAt.toISOString(),
          }),
        );
      }

      reply.setCookie(AUTH_CONSTANTS.SESSION_COOKIE_NAME, jwt, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        expires: expiresAt,
      });

      return reply.redirect(`${authService.getWebUrl()}/members`);
    } catch (e) {
      const error = e instanceof InvalidTokenError ? 'invalid_token' : 'unknown';
      if (redirectTo) {
        return reply.redirect(buildRedirectUrl(redirectTo, { error }));
      }
      return reply.redirect(`${authService.getWebUrl()}/sign-in?error=${error}`);
    }
  });

  // Logout
  app.post('/logout', async (req, reply) => {
    if (req.user) {
      await authService.logout(req.user.sessionId);
    }
    reply.clearCookie(AUTH_CONSTANTS.SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });
    return reply.send({ data: { loggedOut: true } });
  });

  // Current user — public route, manually validates session
  app.get('/me', async (req, reply) => {
    const token = req.cookies?.seventy_session;
    if (!token) return reply.send({ data: null });

    try {
      const user = await authService.validateSession(token);
      return reply.send({ data: { userId: user.userId, email: user.email } });
    } catch {
      return reply.send({ data: null });
    }
  });
}
