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

export interface OutboxSink {
  /** Deliver a batch; throwing aborts the transaction so rows stay pending. */
  deliver(events: OutboxEventRecord[]): Promise<void>;
}

/**
 * TODO(package-f): notifications replace this sink. Package B only persists
 * audit events and marks them dispatched; nothing is sent yet.
 */
export class NoopOutboxSink implements OutboxSink {
  async deliver(): Promise<void> {
    // Intentionally nothing: the notification fan-out is package F.
  }
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

  /** One dispatch pass; returns how many rows were handed to the sink. */
  async dispatch(limit = 100): Promise<{ dispatched: number }> {
    return this.uow.execute(async (tx) => {
      const batch = await this.repo.claimBatch(tx, limit);
      if (batch.length === 0) return { dispatched: 0 };

      await this.sink.deliver(batch);
      await this.repo.markDispatched(tx, batch.map((event) => event.id));
      return { dispatched: batch.length };
    });
  }
}
