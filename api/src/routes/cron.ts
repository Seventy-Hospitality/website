import type { FastifyInstance } from 'fastify';
import { mediaService, membershipService, outboxDispatcher, reservationService } from '@/lib/container';
import { db } from '@/lib/db';
import { cleanupManagedImagesQuerySchema } from '@/src/lib/validation';

// The shared-secret check lives in the `cron` policy (src/middleware/auth.ts).
export async function cronRoutes(app: FastifyInstance) {
  // Release stale pending_payment holds. The sweeper checks the
  // PaymentIntent first: a hold whose payment actually succeeded is
  // confirmed, never expired.
  app.post('/expire-holds', { config: { policy: 'cron' } }, async (_req, reply) => {
    const result = await reservationService.expireStaleHolds();
    return reply.send(result);
  });

  // Hand undispatched audit-log rows to the outbox sink and mark them
  // dispatched (FOR UPDATE SKIP LOCKED; no seq-cursor checkpoints).
  // TODO(package-f): the sink is a no-op until notifications land.
  app.post('/dispatch-outbox', { config: { policy: 'cron' } }, async (_req, reply) => {
    const result = await outboxDispatcher.dispatch();
    return reply.send(result);
  });

  app.get('/sync-memberships', { config: { policy: 'cron' } }, async (_req, reply) => {
    const members = await db.member.findMany({
      where: { stripeCustomerId: { not: null } },
      select: { id: true, stripeCustomerId: true },
    });

    let synced = 0;
    let errors = 0;

    for (const member of members) {
      try {
        await membershipService.syncFromStripe(member.id, member.stripeCustomerId);
        synced++;
      } catch (e) {
        console.error(`Failed to sync member ${member.id}:`, e);
        errors++;
      }
    }

    return reply.send({ synced, errors, total: members.length });
  });

  app.post('/cleanup-event-images', { config: { policy: 'cron' } }, async (req, reply) => {
    const parsed = cleanupManagedImagesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const result = await mediaService.cleanupStaleEventImages(parsed.data);
    return reply.send(result);
  });
}
