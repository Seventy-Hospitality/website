import type { FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '@/lib/container';
import { NotAuthorizedError, type AuthenticatedUser } from '@/lib/contexts/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const PUBLIC_PREFIXES = ['/api/auth/', '/api/webhooks/', '/api/cron/', '/api/health'];

function isPublic(url: string): boolean {
  // Only enforce auth on API routes
  if (!url.startsWith('/api/')) return true;
  return PUBLIC_PREFIXES.some((p) => url.startsWith(p));
}

if (process.env.AUTH_DISABLED === 'true' && process.env.NODE_ENV === 'production') {
  throw new Error('AUTH_DISABLED must not be enabled in production');
}

const DEV_USER: AuthenticatedUser = {
  userId: 'dev_admin',
  sessionId: 'dev_session',
  email: 'dev@seventy.club',
  role: 'admin',
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
  } catch (e) {
    if (e instanceof NotAuthorizedError) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Not authorized' } });
    }
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired session' } });
  }
}
