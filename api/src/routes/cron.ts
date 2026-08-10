import type { FastifyInstance } from 'fastify';
import { mediaService, membershipService } from '@/lib/container';
import { db } from '@/lib/db';
import { cleanupManagedImagesQuerySchema } from '@/src/lib/validation';

// The shared-secret check lives in the `cron` policy (src/middleware/auth.ts).
export async function cronRoutes(app: FastifyInstance) {
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
