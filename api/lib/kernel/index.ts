// Domain primitives (pure, no infrastructure deps)
export { type DomainEvent, type PendingEvent } from './domain-event';
export { type ReplayEventRecord, type ReplayOptions, type ReplayResult } from './replay-event-record';
export { AggregateRoot, type AggregateReducer } from './aggregate-root';

// Persistence abstractions (no concrete implementations)
export { UnitOfWork, type TransactionContext } from './unit-of-work';
export { AggregateRepository } from './aggregate-repository';
export { VersionConflictError } from './version-conflict-error';
export { retryOnConflict } from './retry-on-conflict';
