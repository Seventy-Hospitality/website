import type { TransactionContext } from '@/lib/kernel';

// The deletion saga consumes every other context EXCLUSIVELY through these
// narrow ports, wired in the container to the public services (billing,
// clubs, bookings, identity, members, communications). The account context
// is imported by nothing except the transport layer.

/** Billing seam (BillingService). */
export interface BillingClosurePort {
  /** Entry gate: hard (dispute) AND soft (money in flight) blocks. */
  assertClosable(memberId: string): Promise<void>;
  /** Cancel subscription now, detach PMs, tag customer; ledger survives. */
  closeBillingForMember(memberId: string): Promise<{
    subscriptionCanceled: boolean;
    paymentMethodsDetached: number;
  }>;
}

/** Bookings seam (ReservationService). */
export interface ReservationReleasePort {
  cancelFutureReservationsForMember(
    memberId: string,
    actorId?: string,
  ): Promise<{ cancelled: number; refundCents: number }>;
  releaseParticipationsForMember(memberId: string, actorId?: string): Promise<{ released: number }>;
}

/** Clubs seam (ClubService). */
export interface ClubsReleasePort {
  releaseMemberForAccountDeletion(memberId: string, actorId?: string): Promise<unknown>;
}

/** Identity seam (AccountErasureService). */
export interface IdentityErasurePort {
  quiesce(userId: string, exceptSessionId: string | undefined): Promise<void>;
  revokeAppleTokens(userId: string): Promise<string>;
  eraseCredentials(userId: string, preTombstoneEmail: string): Promise<void>;
  tombstoneUser(userId: string): Promise<void>;
}

/** Members seam (scrub + avatar asset + snapshot). */
export interface MemberErasurePort {
  /** memberNumber snapshot for the request's provenance fields. */
  getMemberNumber(memberId: string): Promise<string | null>;
  /** PII scrub + avatar asset deletion. Idempotent. */
  scrubMember(memberId: string): Promise<void>;
  /** ID-verification photo + row purge. Idempotent. */
  purgeIdVerification(memberId: string): Promise<{ photoDeleted: boolean }>;
}

/** Communications seam (devices + notification preferences). */
export interface NotificationPurgePort {
  purgeForMember(memberId: string): Promise<{ devicesDeleted: number }>;
}

/** Same-transaction audit trail (satisfied by the shared EventStore). */
export interface AuditLog {
  append(
    tx: TransactionContext,
    event: {
      streamType: string;
      streamId: string;
      eventType: string;
      data: unknown;
      actorId?: string;
    },
  ): Promise<unknown>;
}
