import { asPrismaTx, type PrismaTransactionClient } from './prisma-tx';
import type { TransactionContext } from '../kernel/unit-of-work';

export interface AppendEventParams {
  streamType: string;
  streamId: string;
  eventType: string;
  data: unknown;
  occurredAt?: Date;
  source?: string;
  actorId?: string;
}

export interface AppendResult {
  id: string;
  seq: number;
}

/**
 * Event-first write path. Appends events to the Event table.
 * Repositories use this internally; application services use repositories.
 */
export class EventStore {
  async append(tx: TransactionContext, params: AppendEventParams): Promise<AppendResult> {
    const prisma = asPrismaTx(tx);
    const now = params.occurredAt ?? new Date();

    const event = await prisma.event.create({
      data: {
        streamType: params.streamType,
        streamId: params.streamId,
        eventType: params.eventType,
        data: params.data as any,
        occurredAt: now,
        recordedAt: new Date(),
        source: params.source ?? 'app',
        actorId: params.actorId,
      },
    });

    return { id: event.id, seq: event.seq };
  }

  async appendMany(
    tx: TransactionContext,
    events: AppendEventParams[],
  ): Promise<{ count: number }> {
    for (const params of events) {
      await this.append(tx, params);
    }
    return { count: events.length };
  }
}
