import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

// The auth middleware reaches into the composition root; the static routes
// under test are public by construction and never touch these.
vi.mock('@/lib/container', () => ({ sessionService: {}, membershipChecker: {} }));
vi.mock('@/lib/db', () => ({ db: {} }));

import { assertRoutePolicy, authHook } from '@/src/middleware/auth';
import { registerStaticBundles } from './static-bundles';

const MEMBER_INDEX = '<html>member app</html>';
const ADMIN_INDEX = '<html>admin app</html>';

/** Mirrors server.ts: the same policy hooks guard the static registration. */
async function buildApp(publicDir: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRoute', assertRoutePolicy);
  app.addHook('preHandler', authHook);
  app.get('/api/health', { config: { policy: 'public' } }, async () => ({ status: 'ok' }));
  await registerStaticBundles(app, publicDir);
  await app.ready();
  return app;
}

function makePublicDir(bundles: { member?: boolean; admin?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'static-bundles-'));
  if (bundles.member) {
    writeFileSync(join(dir, 'index.html'), MEMBER_INDEX);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'member.js');
  }
  if (bundles.admin) {
    mkdirSync(join(dir, 'admin', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'admin', 'index.html'), ADMIN_INDEX);
    writeFileSync(join(dir, 'admin', 'assets', 'admin.js'), 'admin.js');
  }
  return dir;
}

describe('registerStaticBundles', () => {
  let dir: string | null = null;
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  describe('with both bundles', () => {
    beforeEach(async () => {
      dir = makePublicDir({ member: true, admin: true });
      app = await buildApp(dir);
    });

    it('serves the member app at /', async () => {
      const res = await app!.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(MEMBER_INDEX);
    });

    it('serves member assets directly', async () => {
      const res = await app!.inject({ method: 'GET', url: '/assets/app.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('member.js');
    });

    it('falls back to the member index for deep member routes', async () => {
      const res = await app!.inject({ method: 'GET', url: '/clubs/club_123/members' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(MEMBER_INDEX);
    });

    it('serves the admin app at /admin and /admin/', async () => {
      for (const url of ['/admin', '/admin/']) {
        const res = await app!.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toBe(ADMIN_INDEX);
      }
    });

    it('falls back to the admin index for deep admin routes, query string included', async () => {
      for (const url of ['/admin/members', '/admin/bookings/courts?tab=1']) {
        const res = await app!.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toBe(ADMIN_INDEX);
      }
    });

    it('serves admin assets under the /admin base', async () => {
      const res = await app!.inject({ method: 'GET', url: '/admin/assets/admin.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('admin.js');
    });

    it('does not swallow /admin-prefixed member routes', async () => {
      // /administration is a member-app path, not the admin bundle.
      const res = await app!.inject({ method: 'GET', url: '/administration' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(MEMBER_INDEX);
    });

    it('leaves /api/* routes and their JSON 404s alone', async () => {
      const ok = await app!.inject({ method: 'GET', url: '/api/health' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ status: 'ok' });

      const missing = await app!.inject({ method: 'GET', url: '/api/nope' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('with only the admin bundle (before Package F0 lands member-web)', () => {
    beforeEach(async () => {
      dir = makePublicDir({ admin: true });
      app = await buildApp(dir);
    });

    it('still serves the admin app under /admin', async () => {
      const res = await app!.inject({ method: 'GET', url: '/admin/members' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(ADMIN_INDEX);
    });

    it('404s member routes instead of serving a missing index', async () => {
      const res = await app!.inject({ method: 'GET', url: '/anything' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  it('boots with no public directory at all (API-only dev)', async () => {
    app = await buildApp(join(tmpdir(), 'static-bundles-none-does-not-exist'));

    const api = await app.inject({ method: 'GET', url: '/api/health' });
    expect(api.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });
});
