import type { PrismaClient } from '@prisma/client';
import type { TransactionContext, UnitOfWork } from '../kernel/unit-of-work';
import { asPrismaTx } from './prisma-tx';

/**
 * Transactional outbox over the audit log. Domain mutations append rows to
 * the events table in their own transaction; this dispatcher hands
 * undispatched rows to a sink and marks them dispatched in one transaction.
 *
 * Selection is `dispatchedAt IS NULL ... FOR UPDATE SKIP LOCKED`, never a
 * seq-cursor checkpoint: seq is assigned at insert but commit order differs,
 * so a cursor at N+1 can permanently skip N. Undispatched-row selection has
 * no such gap hazard and lets concurrent dispatchers share the backlog.
 */

export interface OutboxEventRecord {
  id: string;
  seq: number;
  streamType: string;
  streamId: string;
  eventType: string;
  data: unknown;
  occurredAt: Date;
  actorId: string | null;
}

export interface OutboxSinkResult {
  /**
   * Event ids whose delivery failed: they are NOT marked dispatched, stay
   * pending, and are retried on the next pass (retry, never drop). The
   * sink's own idempotency ledger stops the retry from double-sending the
   * notifications that did go out.
   */
  failedEventIds: string[];
}

export interface OutboxSink {
  /**
   * Deliver a batch. Per-event failures are reported in the result;
   * throwing outright aborts the transaction so the WHOLE batch stays
   * pending. Implemented by the communications context's
   * NotificationDispatchService.
   */
  deliver(events: OutboxEventRecord[]): Promise<OutboxSinkResult>;
}

export class OutboxRepository {
  async claimBatch(tx: TransactionContext, limit: number): Promise<OutboxEventRecord[]> {
    const prisma = asPrismaTx(tx);
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      seq: number;
      streamType: string;
      streamId: string;
      eventType: string;
      data: unknown;
      occurredAt: Date;
      actorId: string | null;
    }>>`
      SELECT "id", "seq", "streamType", "streamId", "eventType", "data", "occurredAt", "actorId"
      FROM "events"
      WHERE "dispatchedAt" IS NULL
      ORDER BY "seq"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    return rows;
  }

  async markDispatched(tx: TransactionContext, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const prisma = asPrismaTx(tx);
    await prisma.event.updateMany({
      where: { id: { in: ids } },
      data: { dispatchedAt: new Date() },
    });
  }
}

export class OutboxDispatcher {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: OutboxRepository,
    private readonly sink: OutboxSink,
  ) {}

  /**
   * One dispatch pass. Rows the sink delivered are marked dispatched in the
   * same transaction that locked them; rows it reported failed keep
   * dispatchedAt NULL and are picked up again next pass.
   */
  async dispatch(limit = 100): Promise<{ dispatched: number; failed: number }> {
    return this.uow.execute(async (tx) => {
      const batch = await this.repo.claimBatch(tx, limit);
      if (batch.length === 0) return { dispatched: 0, failed: 0 };

      const result = await this.sink.deliver(batch);
      const failed = new Set(result.failedEventIds);
      const deliveredIds = batch.filter((event) => !failed.has(event.id)).map((event) => event.id);
      await this.repo.markDispatched(tx, deliveredIds);
      return { dispatched: deliveredIds.length, failed: failed.size };
    });
  }
}
