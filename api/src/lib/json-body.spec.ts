import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildTestApp } from '@/src/test/app';
import { error, success } from '@/src/lib/responses';

/**
 * The lenient JSON parser (registered by buildTestApp exactly as server.ts
 * registers it): bodyless POSTs tolerate an empty or absent body while
 * body-taking endpoints keep their zod validation.
 */
describe('lenient JSON body parsing', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp({
      routes: async (instance) => {
        // A bodyless action endpoint (the signout / skip / confirm shape).
        instance.post('/action', { config: { policy: 'public' } }, async (_req, reply) => {
          return success(reply, { done: true });
        });
        // A body-taking endpoint with the standard zod safeParse guard.
        const schema = z.object({ name: z.string().min(1) });
        instance.post('/named', { config: { policy: 'public' } }, async (req, reply) => {
          const parsed = schema.safeParse(req.body);
          if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);
          return success(reply, { name: parsed.data.name });
        });
      },
    });
  });

  afterEach(() => app.close());

  it('accepts an empty application/json body on a bodyless POST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/action',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ done: true });
  });

  it('accepts a POST with no content-type and no body', async () => {
    const res = await app.inject({ method: 'POST', url: '/action' });

    expect(res.statusCode).toBe(200);
  });

  it('still accepts the legacy explicit {} payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/action',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(res.statusCode).toBe(200);
  });

  it('parses a real JSON body unchanged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/named',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Alice' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ name: 'Alice' });
  });

  it('keeps zod validation on endpoints that DO take a body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/named',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/named',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(res.statusCode).toBe(400);
  });
});
