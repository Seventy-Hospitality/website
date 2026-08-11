import type { FastifyInstance } from 'fastify';
import {
  accountDeletionService,
  mediaService,
  membershipService,
  outboxDispatcher,
  reconciliationService,
  reservationService,
} from '@/lib/container';
import { cleanupManagedImagesQuerySchema } from '@/src/lib/validation';

// The shared-secret check lives in the `cron` policy (src/middleware/auth.ts).
// Every job answers GET as well as POST: URL-triggering schedulers (Vercel
// cron and friends) issue GETs; the secret, not the verb, is the guard.
const CRON_METHODS = ['GET', 'POST'] as const;

export async function cronRoutes(app: FastifyInstance) {
  // Release stale pending_payment holds. The sweeper checks the
  // PaymentIntent first: a hold whose payment actually succeeded is
  // confirmed, never expired.
  app.route({
    method: [...CRON_METHODS],
    url: '/expire-holds',
    config: { policy: 'cron' },
    handler: async (_req, reply) => {
      const result = await reservationService.expireStaleHolds();
      return reply.send(result);
    },
  });

  // Hand undispatched audit-log rows to the notification dispatcher and
  // mark the delivered ones dispatched (FOR UPDATE SKIP LOCKED; no
  // seq-cursor checkpoints). A row whose delivery failed stays pending and
  // is retried next pass; the delivered-notifications ledger keeps the
  // retry from double-sending what already went out.
  app.route({
    method: [...CRON_METHODS],
    url: '/dispatch-outbox',
    config: { policy: 'cron' },
    handler: async (_req, reply) => {
      const result = await outboxDispatcher.dispatch();
      return reply.send(result);
    },
  });

  // Nightly account-wide money sweep: charges + invoices + refunds of the
  // last 72h upserted into the ledger, bookings settlement re-driven
  // (closes webhook gaps and the residual pay-vs-drop TOCTOU), webhook
  // dedupe rows pruned.
  app.route({
    method: [...CRON_METHODS],
    url: '/reconcile-billing',
    config: { policy: 'cron' },
    handler: async (_req, reply) => {
      const result = await reconciliationService.reconcileBilling();
      return reply.send(result);
    },
  });

  // Account-wide subscription drift check (replaces the per-member
  // syncFromStripe loop: one list call instead of O(members) reads).
  app.route({
    method: [...CRON_METHODS],
    url: '/subscription-drift',
    config: { policy: 'cron' },
    handler: async (_req, reply) => {
      const result = await membershipService.reconcileSubscriptionDrift();
      return reply.send(result);
    },
  });

  // Re-drives incomplete account-deletion sagas: after the pipeline has
  // revoked the user's credentials they cannot retry through DELETE
  // /api/me, so a mid-pipeline Stripe/Apple failure resumes here (leases
  // prevent a user retry and the cron racing the same request).
  app.route({
    method: [...CRON_METHODS],
    url: '/resume-deletions',
    config: { policy: 'cron' },
    handler: async (_req, reply) => {
      const result = await accountDeletionService.resumeDue();
      return reply.send(result);
    },
  });

  app.route({
    method: [...CRON_METHODS],
    url: '/cleanup-event-images',
    config: { policy: 'cron' },
    handler: async (req, reply) => {
      const parsed = cleanupManagedImagesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const result = await mediaService.cleanupStaleAssets(parsed.data);
      return reply.send(result);
    },
  });
}
