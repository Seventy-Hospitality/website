/**
 * Shape of an event row when replayed from the event store.
 * This is the interface reducers receive — decoupled from Prisma's Event model.
 */
export interface ReplayEventRecord {
  seq: number;
  streamId: string;
  eventType: string;
  data: unknown;
  occurredAt: Date;
  recordedAt: Date;
}

export interface ReplayOptions {
  afterSeq?: number;
  targetSeq?: number;
  batchSize?: number;
  recordedBefore?: Date;
  eventTypes?: string[];
  onReducerError?: 'skip' | 'throw';
}

export interface ReplayResult<T> {
  state: T;
  lastSeq: number | null;
  eventCount: number;
  skippedEventCount: number;
}
