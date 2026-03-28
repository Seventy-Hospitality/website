import type { FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '@/lib/container';
import type { AuthenticatedUser } from '@/lib/contexts/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const PUBLIC_PREFIXES = ['/api/auth/', '/api/webhooks/', '/api/cron/', '/api/health'];

function isPublic(url: string): boolean {
  return PUBLIC_PREFIXES.some((p) => url.startsWith(p));
}

const DEV_USER: AuthenticatedUser = {
  userId: 'dev_admin',
  sessionId: 'dev_session',
  email: 'dev@seventy.club',
};

export async function authHook(req: FastifyRequest, reply: FastifyReply) {
  if (isPublic(req.url)) return;

  // Dev bypass — skip auth entirely in development
  if (process.env.AUTH_DISABLED === 'true') {
    req.user = DEV_USER;
    return;
  }

  const cookieToken = req.cookies?.seventy_session;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const token = cookieToken ?? bearerToken;

  if (!token) {
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }

  try {
    req.user = await authService.validateSession(token);
  } catch {
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired session' } });
  }
}
