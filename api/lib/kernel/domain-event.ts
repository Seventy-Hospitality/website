/**
 * Base shape for all domain events within an aggregate.
 * Concrete aggregates define a discriminated union of these.
 */
export interface DomainEvent<TType extends string = string, TData = Record<string, unknown>> {
  type: TType;
  data: TData;
}

/**
 * An event that has been applied to the aggregate but not yet persisted.
 */
export interface PendingEvent<TEvent extends DomainEvent> {
  event: TEvent;
  occurredAt: string;
}
