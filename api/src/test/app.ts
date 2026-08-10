import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { assertRoutePolicy, authHook } from '@/src/middleware/auth';

export type RouteRegistration = {
  routes: (app: FastifyInstance) => Promise<void>;
  prefix?: string;
};

/**
 * A Fastify instance wired with the same authorization layer as server.ts:
 * the boot assertion plus the policy preHandler. Route specs build their app
 * through this so they exercise real policy enforcement instead of a bare
 * router that would let anything through.
 */
export async function buildTestApp(...registrations: RouteRegistration[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  app.addHook('onRoute', assertRoutePolicy);
  app.addHook('preHandler', authHook);

  for (const { routes, prefix } of registrations) {
    await app.register(routes, { prefix: prefix ?? '/' });
  }

  await app.ready();
  return app;
}
