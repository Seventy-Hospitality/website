import type { TransactionContext } from '@/lib/kernel';
import type { MemberTier } from './resource';

export interface MembershipChecker {
  hasActiveMembership(memberId: string): Promise<boolean>;
  /** Tier of the member's active membership plan; null without one. */
  getTier(memberId: string): Promise<MemberTier | null>;
}

// ── Payments ──

export interface PaymentIntentHandle {
  paymentIntentId: string;
  clientSecret: string;
}

export type PaymentStatus = 'requires_payment' | 'succeeded' | 'failed' | 'canceled';

/**
 * Billing owns Stripe; this port is the seam. The billing context wires an
 * on-session PaymentIntent implementation (idempotency key per reservation
 * attempt, `allow_redirects: 'never'`, metadata.reservationId both
 * directions) plus webhook-driven confirmation; a stub adapter that fakes
 * the client secret and reports instant success remains available for
 * keyless local development.
 */
export interface BookingPaymentPort {
  createPaymentIntent(input: {
    reservationId: string;
    memberId: string;
    amountCents: number;
    attempt: number;
  }): Promise<PaymentIntentHandle>;
  getPaymentStatus(paymentIntentId: string): Promise<PaymentStatus>;
  refund(input: {
    paymentIntentId: string | null;
    amountCents: number;
    reservationId: string;
    /**
     * Stable key for this exact refund reservation (the ledger row id):
     * makes the Stripe call idempotent across crash-retries without ever
     * colliding two legitimate same-amount refunds on one intent.
     */
    refundKey: string;
  }): Promise<{ refundId: string }>;
  cancelPaymentIntent(paymentIntentId: string): Promise<void>;
}

// ── Event claims ──
// The events BC must never write slot_claims directly; it claims courts
// through this port so the exclusion constraint stays the single arbiter.

export interface ClaimedResource {
  id: string;
  name: string;
}

export interface EventClaimConflict {
  reservationId: string;
  reference: string;
  resourceId: string;
  resourceName: string;
  organizerId: string;
  organizerName: string;
  organizerEmail: string;
  localDate: string;
  startTime: string; // "HH:MM" venue-local
  endTime: string;
}

export class EventClaimConflictError extends Error {
  constructor(public readonly conflicts: EventClaimConflict[]) {
    super(
      conflicts.length === 1
        ? 'This event conflicts with 1 existing reservation'
        : `This event conflicts with ${conflicts.length} existing reservations`,
    );
    this.name = 'EventClaimConflictError';
  }
}

export interface ResourceClaimPort {
  getResourcesByIds(ids: string[]): Promise<ClaimedResource[]>;
  /** Resources currently claimed by each event (any claim status). */
  listResourcesForEvents(eventIds: string[]): Promise<Map<string, ClaimedResource[]>>;
  /** Member reservations whose active claim overlaps the range. */
  listEventConflicts(
    resourceIds: string[],
    startsAt: Date,
    endsAt: Date,
  ): Promise<EventClaimConflict[]>;
  /**
   * Force-cancel member reservations to clear the way for an event claim
   * (full refund; the club cancelled, not the member).
   */
  cancelReservations(reservationIds: string[], actorId?: string): Promise<void>;
  /**
   * Replace the event's claims inside the caller's transaction. An inactive
   * event releases everything. Overlap with any active claim raises
   * EventClaimConflictError (mapped from the DB exclusion constraint).
   */
  syncEventClaims(
    tx: TransactionContext,
    input: {
      eventId: string;
      resourceIds: string[];
      startsAt: Date;
      endsAt: Date;
      active: boolean;
    },
  ): Promise<void>;
}
