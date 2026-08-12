import { OutboxDispatcher, type OutboxEventRecord } from './outbox';
import type { UnitOfWork } from '../kernel/unit-of-work';

function record(id: string, seq: number): OutboxEventRecord {
  return {
    id,
    seq,
    streamType: 'reservation',
    streamId: 'rsv_1',
    eventType: 'reservation.created',
    data: {},
    occurredAt: new Date('2026-08-11T00:00:00Z'),
    actorId: null,
  };
}

function build(batch: OutboxEventRecord[]) {
  const uow = { execute: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) } as unknown as UnitOfWork;
  const repo = {
    claimBatch: vi.fn().mockResolvedValue(batch),
    markDispatched: vi.fn().mockResolvedValue(undefined),
  };
  const sink = { deliver: vi.fn().mockResolvedValue({ failedEventIds: [] }) };
  const dispatcher = new OutboxDispatcher(uow, repo as never, sink);
  return { dispatcher, repo, sink };
}

describe('OutboxDispatcher', () => {
  it('hands the claimed batch to the sink and marks delivered rows dispatched', async () => {
    const batch = [record('evt_1', 1), record('evt_2', 2)];
    const { dispatcher, repo, sink } = build(batch);

    const result = await dispatcher.dispatch(50);

    expect(sink.deliver).toHaveBeenCalledWith(batch);
    expect(repo.markDispatched).toHaveBeenCalledWith({}, ['evt_1', 'evt_2']);
    expect(result).toEqual({ dispatched: 2, failed: 0 });
  });

  it('leaves failed events pending (retry, never drop) and marks only the rest', async () => {
    const batch = [record('evt_1', 1), record('evt_2', 2), record('evt_3', 3)];
    const { dispatcher, repo, sink } = build(batch);
    sink.deliver.mockResolvedValue({ failedEventIds: ['evt_2'] });

    const result = await dispatcher.dispatch();

    expect(repo.markDispatched).toHaveBeenCalledWith({}, ['evt_1', 'evt_3']);
    expect(result).toEqual({ dispatched: 2, failed: 1 });
  });

  it('does nothing on an empty backlog', async () => {
    const { dispatcher, repo, sink } = build([]);

    const result = await dispatcher.dispatch();

    expect(sink.deliver).not.toHaveBeenCalled();
    expect(repo.markDispatched).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 0, failed: 0 });
  });

  it('a sink that throws outright aborts the pass so the whole batch stays pending', async () => {
    const { dispatcher, repo, sink } = build([record('evt_1', 1)]);
    sink.deliver.mockRejectedValue(new Error('sink crashed'));

    await expect(dispatcher.dispatch()).rejects.toThrow('sink crashed');
    expect(repo.markDispatched).not.toHaveBeenCalled();
  });
});
