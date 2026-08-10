import type { PrismaClient } from '@prisma/client';

/**
 * Webhook dedupe. The row is written AFTER successful processing: a failed
 * run leaves no tombstone, so Stripe's retry actually reprocesses (writing
 * first and deleting on failure would trade duplicate work, which the
 * idempotent handlers absorb, for irreversible event loss). Keyed on the
 * event id only.
 */
export class WebhookEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async wasProcessed(eventId: string): Promise<boolean> {
    const row = await this.prisma.processedWebhookEvent.findUnique({
      where: { eventId },
      select: { eventId: true },
    });
    return row !== null;
  }

  async markProcessed(eventId: string, type: string): Promise<void> {
    await this.prisma.processedWebhookEvent.createMany({
      data: [{ eventId, type }],
      skipDuplicates: true, // concurrent duplicate deliveries both finish
    });
  }

  /** Retention: Stripe retries for 3 days, manual resends up to ~30. */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.prisma.processedWebhookEvent.deleteMany({
      where: { processedAt: { lt: cutoff } },
    });
    return deleted.count;
  }
}
