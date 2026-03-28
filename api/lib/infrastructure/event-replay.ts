import type { PrismaClient } from '@prisma/client';
import type { ReplayEventRecord, ReplayOptions, ReplayResult } from '../kernel/replay-event-record';

/**
 * Replays events through a reducer to reconstruct aggregate state.
 * Used by repositories to load aggregates and by checkpoint service for snapshots.
 */
export class EventReplay {
  constructor(private readonly prisma: PrismaClient) {}

  async replayStream<T>(
    streamType: string,
    streamId: string,
    reducer: (state: T, event: ReplayEventRecord) => T,
    initialState: T,
    options?: ReplayOptions,
  ): Promise<ReplayResult<T>> {
    return this.replayInternal(streamType, streamId, reducer, initialState, options);
  }

  async replayStreamType<T>(
    streamType: string,
    reducer: (state: T, event: ReplayEventRecord) => T,
    initialState: T,
    options?: ReplayOptions,
  ): Promise<ReplayResult<T>> {
    return this.replayInternal(streamType, null, reducer, initialState, options);
  }

  async getStreamEvents(
    streamType: string,
    streamId: string,
    options?: { afterSeq?: number; targetSeq?: number; limit?: number },
  ) {
    return this.prisma.event.findMany({
      where: {
        streamType,
        streamId,
        ...(options?.afterSeq != null ? { seq: { gt: options.afterSeq } } : {}),
        ...(options?.targetSeq != null ? { seq: { lte: options.targetSeq } } : {}),
      },
      orderBy: { seq: 'asc' },
      take: options?.limit,
    });
  }

  private async replayInternal<T>(
    streamType: string,
    streamId: string | null,
    reducer: (state: T, event: ReplayEventRecord) => T,
    initialState: T,
    options?: ReplayOptions,
  ): Promise<ReplayResult<T>> {
    const batchSize = options?.batchSize ?? 1000;
    let state = initialState;
    let lastSeq: number | null = null;
    let eventCount = 0;
    let skippedEventCount = 0;
    let cursor: number | undefined = options?.afterSeq;

    while (true) {
      const events = await this.prisma.event.findMany({
        where: {
          streamType,
          ...(streamId != null ? { streamId } : {}),
          ...(cursor != null && options?.targetSeq != null
            ? { seq: { gt: cursor, lte: options.targetSeq } }
            : cursor != null
              ? { seq: { gt: cursor } }
              : options?.targetSeq != null
                ? { seq: { lte: options.targetSeq } }
                : {}),
          ...(options?.recordedBefore != null
            ? { recordedAt: { lte: options.recordedBefore } }
            : {}),
          ...(options?.eventTypes?.length ? { eventType: { in: options.eventTypes } } : {}),
        },
        orderBy: { seq: 'asc' },
        take: batchSize,
      });

      if (events.length === 0) break;

      for (const event of events) {
        try {
          state = reducer(state, {
            seq: event.seq,
            streamId: event.streamId,
            eventType: event.eventType,
            data: event.data,
            occurredAt: event.occurredAt,
            recordedAt: event.recordedAt,
          });
        } catch (err) {
          if (options?.onReducerError === 'skip') {
            console.error(`Reducer error at seq=${event.seq}, skipping:`, err);
            skippedEventCount++;
            lastSeq = event.seq;
            eventCount++;
            continue;
          }
          throw err;
        }
        lastSeq = event.seq;
        eventCount++;
      }

      const lastEvent = events[events.length - 1];
      if (lastEvent) cursor = lastEvent.seq;
      if (events.length < batchSize) break;
    }

    return { state, lastSeq, eventCount, skippedEventCount };
  }
}
