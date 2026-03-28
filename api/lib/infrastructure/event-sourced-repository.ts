import type { DomainEvent } from '../kernel/domain-event';
import type { AggregateRoot, AggregateReducer } from '../kernel/aggregate-root';
import { AggregateRepository } from '../kernel/aggregate-repository';
import type { TransactionContext } from '../kernel/unit-of-work';
import { VersionConflictError } from '../kernel/version-conflict-error';
import { asPrismaTx } from './prisma-tx';
import { EventStore } from './event-store';
import { EventReplay } from './event-replay';

export interface SaveOptions {
  source?: string;
  actorId?: string;
  skipVersionCheck?: boolean;
}

/**
 * Loads aggregates by replaying their event stream.
 * Saves by appending uncommitted events to the event store.
 * Uses optimistic concurrency via version checking.
 */
export abstract class EventSourcedAggregateRepository<
  TAggregate extends AggregateRoot<unknown, DomainEvent>,
> extends AggregateRepository<TAggregate> {
  constructor(
    protected readonly eventStore: EventStore,
    protected readonly eventReplay: EventReplay,
    protected readonly streamType: string,
  ) {
    super();
  }

  protected abstract createAggregate(): TAggregate;

  async load(id: string): Promise<TAggregate | null> {
    const events = await this.eventReplay.getStreamEvents(this.streamType, id);
    if (events.length === 0) return null;

    const aggregate = this.createAggregate();
    aggregate.loadFromHistory(
      id,
      events.map((e) => ({
        seq: e.seq,
        streamId: e.streamId,
        eventType: e.eventType,
        data: e.data,
        occurredAt: e.occurredAt,
        recordedAt: e.recordedAt,
      })),
    );

    return aggregate;
  }

  async save(
    tx: TransactionContext,
    aggregate: TAggregate,
    options?: SaveOptions,
  ): Promise<void> {
    if (!aggregate.hasUncommittedEvents) return;

    // Optimistic concurrency check
    if (!options?.skipVersionCheck) {
      const prisma = asPrismaTx(tx);
      const latest = await prisma.event.findFirst({
        where: { streamType: this.streamType, streamId: aggregate.id },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });

      const actualVersion = latest?.seq ?? 0;
      if (actualVersion !== aggregate.version) {
        throw new VersionConflictError(
          this.streamType,
          aggregate.id,
          aggregate.version,
          actualVersion,
        );
      }
    }

    let lastSeq = aggregate.version;
    for (const pending of aggregate.uncommittedEvents) {
      const result = await this.eventStore.append(tx, {
        streamType: this.streamType,
        streamId: aggregate.id,
        eventType: pending.event.type,
        data: pending.event.data,
        occurredAt: new Date(pending.occurredAt),
        source: options?.source ?? 'app',
        actorId: options?.actorId,
      });
      lastSeq = result.seq;
    }

    aggregate.markCommitted(lastSeq);
  }
}
