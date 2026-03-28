import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authService } from '@/lib/container';
import { AUTH_CONSTANTS, InvalidTokenError } from '@/lib/contexts/auth';

export async function authRoutes(app: FastifyInstance) {
  // Send magic link
  app.post('/magic-link', async (req, reply) => {
    const body = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid email' } });
    }

    // Always return success to prevent email enumeration
    await authService.sendMagicLink(body.data.email).catch(() => {});
    return reply.send({ data: { sent: true } });
  });

  // Verify magic link token
  app.get('/verify', async (req, reply) => {
    const query = req.query as { token?: string };
    if (!query.token) {
      return reply.redirect(`${process.env.WEB_URL}/sign-in?error=missing_token`);
    }

    try {
      const { jwt, expiresAt } = await authService.verifyMagicLink(query.token);

      reply.setCookie(AUTH_CONSTANTS.SESSION_COOKIE_NAME, jwt, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        expires: expiresAt,
      });

      return reply.redirect(`${process.env.WEB_URL}/members`);
    } catch (e) {
      const error = e instanceof InvalidTokenError ? 'invalid_token' : 'unknown';
      return reply.redirect(`${process.env.WEB_URL}/sign-in?error=${error}`);
    }
  });

  // Logout
  app.post('/logout', async (req, reply) => {
    if (req.user) {
      await authService.logout(req.user.sessionId);
    }
    reply.clearCookie(AUTH_CONSTANTS.SESSION_COOKIE_NAME, { path: '/' });
    return reply.send({ data: { loggedOut: true } });
  });

  // Current user
  app.get('/me', async (req, reply) => {
    if (!req.user) {
      return reply.send({ data: null });
    }
    return reply.send({ data: { userId: req.user.userId, email: req.user.email } });
  });
}
