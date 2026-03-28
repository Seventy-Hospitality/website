import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { authHook } from './middleware/auth';
import { memberRoutes } from './routes/members';
import { authRoutes } from './routes/auth';
import { stripeRoutes } from './routes/stripe';
import { webhookRoutes } from './routes/webhooks';
import { cronRoutes } from './routes/cron';
import { bookingRoutes } from './routes/bookings';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_URL ?? 'http://localhost:5173',
  credentials: true,
});

await app.register(cookie);

app.addHook('preHandler', authHook);

// Routes
await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(memberRoutes, { prefix: '/api/members' });
await app.register(stripeRoutes, { prefix: '/api/stripe' });
await app.register(webhookRoutes, { prefix: '/api/webhooks' });
await app.register(cronRoutes, { prefix: '/api/cron' });
await app.register(bookingRoutes, { prefix: '/api' });

// Health check
app.get('/api/health', async () => ({ status: 'ok' }));

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
console.log(`Seventy API running on http://localhost:${port}`);
