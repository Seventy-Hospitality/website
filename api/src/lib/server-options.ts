import type { FastifyServerOptions } from 'fastify';

/**
 * Fastify options for the production server.
 *
 * `trustProxy` is required: the API runs behind a TLS-terminating reverse proxy
 * (Caddy on Lightsail, the managed ingress on App Runner), so without it every
 * request's `req.ip` is the proxy's own address. That would collapse
 * @fastify/rate-limit onto a single global bucket (one caller could 429 the
 * whole club's sign-in) and stamp the proxy address onto every
 * `auth_sessions.ip` audit row. With it, `req.ip` resolves from
 * X-Forwarded-For. The API container publishes no ports of its own, so the only
 * possible socket peer is the trusted proxy.
 */
export const SERVER_FASTIFY_OPTIONS: FastifyServerOptions = {
  logger: true,
  trustProxy: true,
};
