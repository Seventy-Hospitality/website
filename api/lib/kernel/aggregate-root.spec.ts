import { AggregateRoot, type AggregateReducer } from './aggregate-root';
import type { DomainEvent } from './domain-event';
import type { ReplayEventRecord } from './replay-event-record';

// ── Test fixtures ──

interface CounterState {
  count: number;
}

type CounterEvent =
  | DomainEvent<'Incremented', { amount: number }>
  | DomainEvent<'Decremented', { amount: number }>;

const counterReducer: AggregateReducer<CounterState, CounterEvent> = (
  state: CounterState,
  event: ReplayEventRecord,
): CounterState => {
  switch (event.eventType) {
    case 'Incremented':
      return { count: state.count + (event.data as { amount: number }).amount };
    case 'Decremented':
      return { count: state.count - (event.data as { amount: number }).amount };
    default:
      return state;
  }
};

class Counter extends AggregateRoot<CounterState, CounterEvent> {
  constructor() {
    super({ count: 0 }, counterReducer, 'counter');
  }

  static create(id: string): Counter {
    const c = new Counter();
    c['initialize'](id);
    return c;
  }

  increment(amount = 1) {
    this.apply({ type: 'Incremented', data: { amount } });
  }

  decrement(amount = 1) {
    this.apply({ type: 'Decremented', data: { amount } });
  }
}

// ── Tests ──

describe('AggregateRoot', () => {
  it('starts with initial state', () => {
    const counter = Counter.create('c1');
    expect(counter.state.count).toBe(0);
    expect(counter.id).toBe('c1');
    expect(counter.version).toBe(0);
  });

  it('applies events and updates state', () => {
    const counter = Counter.create('c1');
    counter.increment(5);
    counter.increment(3);

    expect(counter.state.count).toBe(8);
    expect(counter.uncommittedEvents).toHaveLength(2);
    expect(counter.hasUncommittedEvents).toBe(true);
  });

  it('tracks uncommitted events', () => {
    const counter = Counter.create('c1');
    counter.increment(1);
    counter.decrement(2);

    expect(counter.uncommittedEvents[0].event.type).toBe('Incremented');
    expect(counter.uncommittedEvents[1].event.type).toBe('Decremented');
    expect(counter.state.count).toBe(-1);
  });

  it('clears uncommitted events on markCommitted', () => {
    const counter = Counter.create('c1');
    counter.increment(1);
    counter.markCommitted(42);

    expect(counter.uncommittedEvents).toHaveLength(0);
    expect(counter.hasUncommittedEvents).toBe(false);
    expect(counter.version).toBe(42);
    expect(counter.state.count).toBe(1); // state preserved
  });

  it('loads from history', () => {
    const counter = new Counter();
    const now = new Date();

    counter.loadFromHistory('c1', [
      { seq: 1, streamId: 'c1', eventType: 'Incremented', data: { amount: 10 }, occurredAt: now, recordedAt: now },
      { seq: 2, streamId: 'c1', eventType: 'Decremented', data: { amount: 3 }, occurredAt: now, recordedAt: now },
    ]);

    expect(counter.id).toBe('c1');
    expect(counter.state.count).toBe(7);
    expect(counter.version).toBe(2);
    expect(counter.hasUncommittedEvents).toBe(false);
  });

  it('can apply new events after loading from history', () => {
    const counter = new Counter();
    const now = new Date();

    counter.loadFromHistory('c1', [
      { seq: 1, streamId: 'c1', eventType: 'Incremented', data: { amount: 10 }, occurredAt: now, recordedAt: now },
    ]);

    counter.increment(5);

    expect(counter.state.count).toBe(15);
    expect(counter.version).toBe(1); // version unchanged until committed
    expect(counter.uncommittedEvents).toHaveLength(1);
  });

  it('loads from base state and version', () => {
    const counter = new Counter();
    const now = new Date();

    counter.loadFromHistory(
      'c1',
      [{ seq: 11, streamId: 'c1', eventType: 'Incremented', data: { amount: 1 }, occurredAt: now, recordedAt: now }],
      { count: 100 },
      10,
    );

    expect(counter.state.count).toBe(101);
    expect(counter.version).toBe(11);
  });

  it('throws when accessing id before initialization', () => {
    const counter = new Counter();
    expect(() => counter.id).toThrow('Aggregate has no ID');
  });
});
