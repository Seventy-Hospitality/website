// Account bounded context (package E): the resumable account-deletion saga
// and nothing else. It consumes billing, bookings, clubs, identity, members
// and communications exclusively through the ports in application/ports.ts
// (wired in the container to their public services) and is imported by
// nothing but the transport layer.

export { AccountDeletionService } from './application';
export type { DeletionOutcome, RequestDeletionInput } from './application';
export { DeletionRequestRepository } from './infrastructure';
export type { DeletionRequestRecord } from './infrastructure';
export {
  DELETION_STEPS,
  MAX_DELETION_ATTEMPTS,
  type DeletionRequestStatus,
  type DeletionStep,
} from './domain';
