import type { TransactionContext } from '@/lib/kernel';

/**
 * Same-transaction audit trail plus outbox feed (satisfied by the shared
 * EventStore). Every reservation mutation appends its reservation.* events
 * through this inside the mutating transaction; the outbox dispatcher hands
 * undispatched rows to package F later.
 */
export interface AuditLog {
  append(
    tx: TransactionContext,
    event: {
      streamType: string;
      streamId: string;
      eventType: string;
      data: unknown;
      actorId?: string;
      source?: string;
    },
  ): Promise<unknown>;
}
