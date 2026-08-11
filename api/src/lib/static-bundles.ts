import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the bundled web apps from one public directory, same-origin with the
 * API so session cookies need no CORS:
 *
 * - `publicDir/`        member app at `/` (the primary consumer app)
 * - `publicDir/admin/`  admin app under `/admin` (built with base `/admin/`)
 *
 * Each bundle gets its own SPA history fallback; `/api/*` misses stay JSON
 * 404s. Either bundle may be absent (the member app lands with Package F0;
 * dev runs serve no bundle at all) — the fallback only serves an index that
 * exists, so the API boots and behaves the same without them.
 */
export async function registerStaticBundles(app: FastifyInstance, publicDir: string): Promise<void> {
  if (!existsSync(publicDir)) return;

  const fastifyStatic = await import('@fastify/static');
  await app.register(fastifyStatic.default, {
    root: publicDir,
    wildcard: false,
  });

  // Bundles are baked into the image; existence cannot change at runtime.
  const hasMemberIndex = existsSync(join(publicDir, 'index.html'));
  const hasAdminIndex = existsSync(join(publicDir, 'admin', 'index.html'));

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0];

    if (path.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    }
    if ((path === '/admin' || path.startsWith('/admin/')) && hasAdminIndex) {
      return reply.sendFile('admin/index.html');
    }
    if (hasMemberIndex) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
}
