import type { FastifyRequest, FastifyReply } from 'fastify';
import { NotAuthorizedError, type AuthenticatedUser } from '@/lib/contexts/identity';
import { authenticateRequest } from '@/src/lib/auth-cookies';

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
  emailVerifiedAt: new Date(),
  staffRole: 'admin',
  client: 'admin_web',
};

export async function authHook(req: FastifyRequest, reply: FastifyReply) {
  if (isPublic(req.url)) return;

  // Dev bypass — skip auth entirely in development
  if (process.env.AUTH_DISABLED === 'true') {
    req.user = DEV_USER;
    return;
  }

  let user: AuthenticatedUser | null;
  try {
    user = await authenticateRequest(req, reply);
  } catch (e) {
    if (e instanceof NotAuthorizedError) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Not authorized' } });
    }
    throw e;
  }

  if (!user) {
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }

  // Stage 1 keeps the pre-existing global admin gate on every guarded route;
  // the stage 2 policy rewrite replaces it with per-route policies.
  if (user.staffRole !== 'admin') {
    return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Not authorized' } });
  }

  req.user = user;
}
