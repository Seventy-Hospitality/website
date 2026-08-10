import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { SERVER_FASTIFY_OPTIONS } from './lib/server-options';
import { assertRoutePolicy, authHook } from './middleware/auth';
import { memberRoutes } from './routes/members';
import { authRoutes } from './routes/auth';
import { stripeRoutes } from './routes/stripe';
import { webhookRoutes } from './routes/webhooks';
import { cronRoutes } from './routes/cron';
import { bookingRoutes } from './routes/bookings';
import { reservationRoutes } from './routes/reservations';
import { eventRoutes } from './routes/events';
import { mediaRoutes } from './routes/media';
import { uploadAssetRoutes } from './routes/uploads';
import { meRoutes } from './routes/me';
import { meBillingRoutes } from './routes/me-billing';
import { meMembershipRoutes } from './routes/me-membership';

const app = Fastify(SERVER_FASTIFY_OPTIONS);

function getAllowedWebOrigins(configuredWebUrl: string): string[] {
  const origins = new Set<string>([configuredWebUrl]);

  try {
    const url = new URL(configuredWebUrl);
    if (url.hostname === 'localhost') {
      url.hostname = '127.0.0.1';
      origins.add(url.toString().replace(/\/$/, ''));
    } else if (url.hostname === '127.0.0.1') {
      url.hostname = 'localhost';
      origins.add(url.toString().replace(/\/$/, ''));
    }
  } catch {
    // Fall back to the configured origin only when WEB_URL is not a valid URL.
  }

  return [...origins];
}

const webOrigins = getAllowedWebOrigins(process.env.WEB_URL ?? 'http://localhost:5173');

await app.register(cors, {
  origin: webOrigins,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
});

await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
});

await app.register(cookie);

await app.register(multipart);

// Authorization: the boot assertion must see every route that follows, so it
// is installed before the first registration.
app.addHook('onRoute', assertRoutePolicy);
app.addHook('preHandler', authHook);

// Routes
await app.register(uploadAssetRoutes, { prefix: '/uploads' });
await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(memberRoutes, { prefix: '/api/members' });
await app.register(stripeRoutes, { prefix: '/api/stripe' });
await app.register(webhookRoutes, { prefix: '/api/webhooks' });
await app.register(cronRoutes, { prefix: '/api/cron' });
await app.register(bookingRoutes, { prefix: '/api' });
await app.register(reservationRoutes, { prefix: '/api' });
await app.register(eventRoutes, { prefix: '/api/events' });
await app.register(mediaRoutes, { prefix: '/api/media' });
await app.register(meRoutes, { prefix: '/api/me' });
await app.register(meMembershipRoutes, { prefix: '/api/me' });
await app.register(meBillingRoutes, { prefix: '/api/me' });
import { adminRoutes } from './routes/admin';
await app.register(adminRoutes, { prefix: '/api/admin' });

// Plans — the catalog is shown before signup, so it is public
import { planRepo } from '@/lib/container';
app.get('/api/plans', { config: { policy: 'public' } }, async (_req, reply) => {
  const plans = await planRepo.list();
  return reply.send({ data: plans });
});

// Health check
app.get('/api/health', { config: { policy: 'public' } }, async () => ({ status: 'ok' }));

// Serve bundled web app in production
const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', '..', 'public');

if (existsSync(publicDir)) {
  const fastifyStatic = await import('@fastify/static');
  await app.register(fastifyStatic.default, {
    root: publicDir,
    wildcard: false,
  });

  // SPA fallback: serve index.html for non-API routes
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    }
    return reply.sendFile('index.html');
  });
}

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
console.log(`Seventy API running on http://localhost:${port}`);
