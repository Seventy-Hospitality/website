import type { preHandlerHookHandler } from 'fastify';
import { error } from './responses';

/**
 * Per-principal rate limiting for authenticated sensitive endpoints
 * (step-up password guesses, re-auth email minting). The global
 * @fastify/rate-limit hook runs at onRequest, before the auth preHandler
 * populates req.principal, so it can only key on IP; an attacker rotating
 * IPs against a KNOWN account would get unlimited guesses. This limiter
 * runs as a ROUTE-level preHandler (after the auth hook) and keys on the
 * userId. In-memory, same trade-off as the plugin's default store.
 */
export function perUserRateLimit(max: number, windowMs: number): preHandlerHookHandler {
  const hits = new Map<string, number[]>();

  return async function rateLimitByUser(req, reply) {
    const key = req.principal?.userId ?? req.ip;
    const now = Date.now();
    const windowStart = now - windowMs;

    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= max) {
      return error(reply, 'RATE_LIMITED', 'Too many attempts; try again later', 429);
    }
    recent.push(now);
    hits.set(key, recent);

    // Bound the map: drop keys whose entries all aged out.
    if (hits.size > 10_000) {
      for (const [k, stamps] of hits) {
        if (stamps.every((t) => t <= windowStart)) hits.delete(k);
      }
    }
  };
}
