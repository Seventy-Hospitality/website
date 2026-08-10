import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { membershipChecker } from '@/lib/container';
import { NotAuthorizedError, type Principal } from '@/lib/contexts/identity';
import { authenticateRequest } from '@/src/lib/auth-cookies';
import { error } from '@/src/lib/responses';

/**
 * Authorization ladder. Every route declares exactly one policy; there is no
 * default and no allowlist, so a route that forgets to declare crashes the
 * boot instead of quietly serving unauthenticated callers.
 *
 * - public        no authentication at all
 * - authenticated any valid session (used before a club profile exists)
 * - member        authenticated and has a Member profile
 * - active-member member with an active membership
 * - staff         staffRole staff or admin
 * - admin         staffRole admin
 * - cron          Bearer CRON_SECRET, no user
 * - webhook       pass-through; the route verifies the provider signature
 *
 * Resource ownership (this booking is mine, this club is mine) stays in the
 * services; the ladder only answers "what kind of caller is this".
 */
export const POLICIES = [
  'public',
  'authenticated',
  'member',
  'active-member',
  'staff',
  'admin',
  'cron',
  'webhook',
] as const;

export type Policy = (typeof POLICIES)[number];

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }

  interface FastifyContextConfig {
    policy: Policy;
  }
}

if (process.env.AUTH_DISABLED === 'true' && process.env.NODE_ENV === 'production') {
  throw new Error('AUTH_DISABLED must not be enabled in production');
}

/**
 * The dev bypass has to satisfy whatever policy the route under test declares,
 * so it is a complete principal: staff powers and a club profile.
 */
const DEV_PRINCIPAL: Principal = {
  userId: 'dev_admin',
  sessionId: 'dev_session',
  email: 'dev@seventy.club',
  emailVerified: true,
  staffRole: 'admin',
  memberId: 'dev_member',
  client: 'admin_web',
};

/**
 * Boot assertion (`onRoute`): fail closed on an undeclared policy.
 *
 * The one exemption is @fastify/static, which generates a route per file of
 * the bundled web app and cannot declare config of its own; it stamps
 * `{ file, rootPath }` on the routes it creates. That bundle is public by
 * construction, and the policy is written back so the request hook still sees
 * an explicit declaration.
 */
export function assertRoutePolicy(route: RouteOptions): void {
  if (route.config?.policy) return;

  if (isBundledStaticAsset(route.config)) {
    route.config = { ...route.config, policy: 'public' };
    return;
  }

  const method = Array.isArray(route.method) ? route.method.join('/') : route.method;
  throw new Error(
    `Route ${method} ${route.url} declares no auth policy. Add config: { policy: '...' } (see src/middleware/auth.ts).`,
  );
}

function isBundledStaticAsset(config: unknown): boolean {
  return (
    typeof config === 'object' &&
    config !== null &&
    'rootPath' in config &&
    'file' in config
  );
}

/** Enforces the declared policy (`preHandler`). */
export async function authHook(req: FastifyRequest, reply: FastifyReply) {
  const policy = req.routeOptions?.config?.policy as Policy | undefined;

  // No policy means no route matched: the not-found handler owns the reply.
  if (!policy || policy === 'public') return;

  // The route verifies the Stripe signature; there is no principal to build.
  if (policy === 'webhook') return;

  if (policy === 'cron') return authorizeCron(req, reply);

  if (process.env.AUTH_DISABLED === 'true') {
    req.principal = DEV_PRINCIPAL;
    return;
  }

  let principal: Principal | null;
  try {
    principal = await authenticateRequest(req, reply);
  } catch (e) {
    if (e instanceof NotAuthorizedError) return forbidden(reply);
    throw e;
  }

  if (!principal) {
    return error(reply, 'UNAUTHORIZED', 'Authentication required', 401);
  }

  switch (policy) {
    case 'authenticated':
      break;

    case 'member':
    case 'active-member': {
      if (!principal.memberId) {
        return error(reply, 'PROFILE_REQUIRED', 'No member profile found for this account', 403);
      }
      if (policy === 'active-member' && !(await membershipChecker.hasActiveMembership(principal.memberId))) {
        return error(reply, 'INACTIVE_MEMBERSHIP', 'An active membership is required', 403);
      }
      break;
    }

    case 'staff':
      if (principal.staffRole === null) return forbidden(reply);
      break;

    case 'admin':
      if (principal.staffRole !== 'admin') return forbidden(reply);
      break;

    default: {
      // A new rung of the ladder must be handled here, not fall through.
      const unhandled: never = policy;
      throw new Error(`Unhandled auth policy: ${String(unhandled)}`);
    }
  }

  req.principal = principal;
}

function forbidden(reply: FastifyReply) {
  return error(reply, 'FORBIDDEN', 'Not authorized', 403);
}

/** Cron schedulers authenticate with a shared secret, not a session. */
function authorizeCron(req: FastifyRequest, reply: FastifyReply) {
  const secret = process.env.CRON_SECRET;
  const presented = req.headers.authorization;

  if (!secret || !presented || !secretsMatch(presented, `Bearer ${secret}`)) {
    return error(reply, 'UNAUTHORIZED', 'Authentication required', 401);
  }
}

function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
