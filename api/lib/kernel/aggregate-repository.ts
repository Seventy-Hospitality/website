import type { TransactionContext } from './unit-of-work';

export abstract class AggregateRepository<TAggregate> {
  abstract load(id: string): Promise<TAggregate | null>;
  abstract save(tx: TransactionContext, aggregate: TAggregate): Promise<void>;
}
