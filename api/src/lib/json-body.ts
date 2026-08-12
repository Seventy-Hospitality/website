import type { FastifyInstance } from 'fastify';

/**
 * JSON body parsing with one relaxation over Fastify's default: an EMPTY
 * `application/json` body parses to `undefined` instead of failing with
 * FST_ERR_CTP_EMPTY_JSON_BODY. Browsers and fetch wrappers commonly stamp
 * the JSON content type on every POST, so bodyless endpoints (signout,
 * resend-verification, id-verification submit/skip, membership confirm,
 * billing-portal) would otherwise force clients to send a dummy `'{}'`.
 *
 * Validation is NOT weakened for endpoints that do take a body: they parse
 * `req.body` through zod, and `undefined` fails those schemas exactly like
 * a missing field would (a 400 VALIDATION_ERROR instead of the parser-level
 * 400). Malformed non-empty JSON still answers 400 at the parser.
 *
 * Scope note: the Stripe webhook route registers its own scoped
 * `application/json` parser (raw string for signature verification), which
 * overrides this one inside its plugin scope.
 */
export function registerLenientJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      const parseError = err instanceof Error ? err : new Error('Invalid JSON body');
      (parseError as Error & { statusCode?: number }).statusCode = 400;
      done(parseError, undefined);
    }
  });
}
