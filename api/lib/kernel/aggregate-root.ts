import type { DomainEvent, PendingEvent } from './domain-event';
import type { ReplayEventRecord } from './replay-event-record';

export type AggregateReducer<TState, _TEvent extends DomainEvent = DomainEvent> = (
  state: TState,
  event: ReplayEventRecord,
) => TState;

export abstract class AggregateRoot<TState, TEvent extends DomainEvent> {
  private _state: TState;
  private _version: number = 0;
  private _uncommitted: PendingEvent<TEvent>[] = [];
  private _id: string | null = null;

  constructor(
    initialState: TState,
    private readonly reducer: AggregateReducer<TState, TEvent>,
    public readonly streamType: string,
  ) {
    this._state = initialState;
  }

  get state(): TState {
    return this._state;
  }

  get version(): number {
    return this._version;
  }

  get id(): string {
    if (!this._id) throw new Error('Aggregate has no ID — load or initialize first');
    return this._id;
  }

  get uncommittedEvents(): ReadonlyArray<PendingEvent<TEvent>> {
    return this._uncommitted;
  }

  get hasUncommittedEvents(): boolean {
    return this._uncommitted.length > 0;
  }

  protected initialize(id: string): void {
    this._id = id;
  }

  loadFromHistory(
    id: string,
    events: ReplayEventRecord[],
    baseState?: TState,
    baseVersion?: number,
  ): void {
    this._id = id;
    if (baseState !== undefined) this._state = baseState;
    if (baseVersion !== undefined) this._version = baseVersion;

    for (const event of events) {
      this._state = this.reducer(this._state, event);
      this._version = event.seq;
    }

    this._uncommitted = [];
  }

  protected apply(event: TEvent, occurredAt?: Date): void {
    const now = occurredAt ?? new Date();
    const isoTimestamp = now.toISOString();

    const record: ReplayEventRecord = {
      seq: 0,
      streamId: this.id,
      eventType: event.type,
      data: event.data,
      occurredAt: now,
      recordedAt: now,
    };

    this._state = this.reducer(this._state, record);
    this._uncommitted.push({ event, occurredAt: isoTimestamp });
  }

  markCommitted(lastSeq: number): void {
    this._version = lastSeq;
    this._uncommitted = [];
  }
}
