// ── Account-deletion saga (pure definitions) ──
// The pipeline is a fixed, ordered list of idempotent steps persisted per
// request, so a mid-pipeline failure (Stripe down, Apple unreachable)
// resumes exactly where it stopped. Steps that talk to external systems
// are separate from pure-DB steps because they are the units of retry.

export const DELETION_STEPS = [
  // (a) Freeze before destruction: stamp users.deletionRequestedAt, revoke
  // every other session, delete push devices. A pipeline step (not
  // creation-only code) so EVERY entry path re-applies it: a request row
  // that persisted moments before the quiesce write failed must never
  // drive the erasure against a live, unfrozen account.
  'quiesce',
  // (b) Cancel the member's own FUTURE reservations at the tier refund
  // policy (Stripe refunds), then decline their guest participations on
  // other members' bookings (pure DB).
  'cancel_reservations',
  'release_participations',
  // (c) Cancel subscription now, detach payment methods, tag the Stripe
  // customer; NEVER customers.del(); the ledger survives. Re-checks the
  // HARD closure block (open dispute) only.
  'close_billing',
  // (d) Transfer/delete clubs, withdraw invitations, revoke invite links.
  'release_clubs',
  // (e) split: Apple /auth/revoke BEFORE the identity rows are deleted
  // (deleting first destroys the only copy of the refresh token), then
  // credentials + identities + one-time tokens + remaining sessions.
  'revoke_apple',
  'erase_credentials',
  // (f) users: status='deleted', deletedAt, email tombstone.
  'tombstone_user',
  // (g) members: PII scrub, memberNumber retired on the surviving row;
  // avatar asset deleted; notification prefs + any remaining devices go.
  'scrub_member',
  // (h) ID-verification photo asset + row purged.
  'purge_id_verification',
  // (i) audit + outbox event committed in the SAME transaction that flips
  // the request to completed.
  'finalize',
] as const;

export type DeletionStep = (typeof DELETION_STEPS)[number];

/** Bumped whenever the step list changes shape (in-flight rows keep theirs;
 *  the run loop always executes the CURRENT list, and quiesce is idempotent,
 *  so v1 rows pick the quiesce step up on their next resume). */
export const DELETION_STEPS_VERSION = 2;

export type DeletionRequestStatus = 'in_progress' | 'failed' | 'blocked' | 'completed';

export interface StepState {
  completedAt?: string;
  attempts?: number;
  lastError?: string;
  /** Step outcome payload (counts, refund totals, transfers); also the
   *  data the final account.deleted event carries — unrecoverable once
   *  the rows are scrubbed. */
  result?: unknown;
}

export type StepsMap = Partial<Record<DeletionStep, StepState>>;

/** Total runs before the request flips to blocked for staff attention. */
export const MAX_DELETION_ATTEMPTS = 20;

/** Exponential backoff for the resume cron: 1m, 2m, 4m ... capped at 6h. */
export function nextAttemptDelayMs(attempts: number): number {
  const base = 60_000 * 2 ** Math.max(0, Math.min(attempts, 30));
  return Math.min(base, 6 * 60 * 60 * 1000);
}

export function pendingSteps(steps: StepsMap): DeletionStep[] {
  return DELETION_STEPS.filter((step) => !steps[step]?.completedAt);
}
