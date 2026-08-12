import { randomUUID } from 'crypto';
import type { UnitOfWork } from '@/lib/kernel';
import {
  DELETION_STEPS,
  DELETION_STEPS_VERSION,
  MAX_DELETION_ATTEMPTS,
  nextAttemptDelayMs,
  type DeletionStep,
  type StepsMap,
} from '../domain';
import type {
  DeletionRequestRecord,
  DeletionRequestRepository,
} from '../infrastructure/deletion-request.repository';
import type {
  AuditLog,
  BillingClosurePort,
  ClubsReleasePort,
  IdentityErasurePort,
  MemberErasurePort,
  NotificationPurgePort,
  ReservationReleasePort,
} from './ports';

export interface RequestDeletionInput {
  userId: string;
  memberId: string | null;
  sessionId: string | undefined;
  email: string;
  stepUpMethod: string;
  client?: string | null;
  ip?: string | null;
}

export interface DeletionOutcome {
  status: DeletionRequestRecord['status'];
  requestId: string;
  blockedReasons?: string[];
}

/**
 * Lease TTL: a run killed mid-flight is re-drivable after this window.
 * Every completed step renews it (heartbeat), so the budget applies per
 * step, not per pipeline; a run that loses the lease anyway abandons on
 * its next write (every write is compare-and-set on lockedBy).
 */
const LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * Internal control flow: this worker's lease expired mid-run and another
 * worker claimed it. Abandon without recording anything — the thief owns
 * the row now, and steps are idempotent so it re-driving our tail is safe.
 */
class DeletionLeaseLostError extends Error {
  constructor() {
    super('Deletion lease lost to another worker');
    this.name = 'DeletionLeaseLostError';
  }
}

/**
 * The resumable account-deletion saga. One request per user; every step is
 * idempotent, external-effect steps are their own units of retry, and
 * progress persists so a mid-pipeline Stripe/Apple failure resumes exactly
 * where it stopped (via the user retrying DELETE /api/me while their
 * session lives, or the resume cron once it does not).
 */
export class AccountDeletionService {
  private readonly workerId = `worker-${randomUUID()}`;

  constructor(
    private readonly repo: DeletionRequestRepository,
    private readonly billing: BillingClosurePort,
    private readonly reservations: ReservationReleasePort,
    private readonly clubs: ClubsReleasePort,
    private readonly identity: IdentityErasurePort,
    private readonly members: MemberErasurePort,
    private readonly notifications: NotificationPurgePort,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async getForUser(userId: string): Promise<DeletionRequestRecord | null> {
    return this.repo.findByUserId(userId);
  }

  /**
   * Creates (or resumes) the user's deletion request and drives it. The
   * caller has already verified step-up for a NEW request; an existing
   * request resumes without new proof (its creation already carried it).
   *
   * Entry gate: billing.assertClosable (hard AND soft blocks) runs before
   * anything is persisted, so a member with money in flight gets a clean
   * 409 and an untouched account.
   */
  async request(input: RequestDeletionInput): Promise<DeletionOutcome> {
    let request = await this.repo.findByUserId(input.userId);

    if (!request) {
      if (input.memberId) await this.billing.assertClosable(input.memberId);

      const memberNumber = input.memberId ? await this.members.getMemberNumber(input.memberId) : null;
      try {
        request = await this.repo.create({
          userId: input.userId,
          memberId: input.memberId,
          requestedByUserId: input.userId,
          stepsVersion: DELETION_STEPS_VERSION,
          stepUpMethod: input.stepUpMethod,
          client: input.client ?? null,
          ip: input.ip ?? null,
          emailAtRequest: input.email,
          memberNumberAtRequest: memberNumber,
        });
      } catch (err) {
        // Two devices raced on the unique userId: adopt the winner's row.
        request = await this.repo.findByUserId(input.userId);
        if (!request) throw err;
      }
    }

    // The freeze (quiesce) is the pipeline's FIRST step, not creation-only
    // code: a request that persisted but never quiesced (transient error
    // between create and freeze) re-applies it on every resume path before
    // anything destructive runs. The driving session survives for retries.
    return this.run(request, input.sessionId);
  }

  /** Cron entry: re-drives due requests (expired leases included). */
  async resumeDue(limit = 10, now: Date = new Date()): Promise<{ resumed: number; completed: number; blocked: number; failed: number }> {
    const due = await this.repo.listDue(limit, now);
    const summary = { resumed: 0, completed: 0, blocked: 0, failed: 0 };
    for (const request of due) {
      summary.resumed += 1;
      const outcome = await this.run(request);
      if (outcome.status === 'completed') summary.completed += 1;
      else if (outcome.status === 'blocked') summary.blocked += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  private async run(
    request: DeletionRequestRecord,
    exceptSessionId?: string,
  ): Promise<DeletionOutcome> {
    if (request.status === 'completed') {
      return { status: 'completed', requestId: request.id };
    }
    if (request.status === 'blocked') {
      return { status: 'blocked', requestId: request.id, blockedReasons: request.blockedReasons };
    }

    // Claim + re-read in one repository call: the claimed record is the
    // ONLY snapshot this run drives from. Seeding from the caller's
    // pre-claim read would let a worker that claimed an expired lease
    // re-run steps the previous holder had since persisted.
    const claimed = await this.repo.claimLease(request.id, this.workerId, LEASE_TTL_MS);
    if (!claimed) {
      // Another worker is driving it right now.
      return { status: 'in_progress', requestId: request.id };
    }
    request = claimed;

    const steps: StepsMap = { ...request.steps };
    try {
      for (const step of DELETION_STEPS) {
        if (steps[step]?.completedAt) continue;

        try {
          const result = await this.executeStep(step, request, steps, exceptSessionId);
          steps[step] = {
            ...steps[step],
            completedAt: new Date().toISOString(),
            result: result ?? undefined,
          };
          // finalize persists its own completion inside its transaction;
          // every other save doubles as the lease heartbeat.
          if (step !== 'finalize') await this.persistStepCompleted(request.id, steps);
        } catch (err) {
          if (err instanceof DeletionLeaseLostError) throw err;
          return await this.handleStepFailure(request, steps, step, err);
        }
      }
      return { status: 'completed', requestId: request.id };
    } catch (err) {
      if (err instanceof DeletionLeaseLostError) {
        // The lease expired mid-run and another worker took over. Abandon
        // without writing: the thief owns every subsequent write, and the
        // compare-and-set guards guarantee only ITS finalize can commit
        // the terminal account.deleted event.
        return { status: 'in_progress', requestId: request.id };
      }
      throw err;
    } finally {
      await this.repo.releaseLease(request.id, this.workerId).catch(() => {});
    }
  }

  /** Lease-guarded step save; throws DeletionLeaseLostError when stolen. */
  private async persistStepCompleted(requestId: string, steps: StepsMap): Promise<void> {
    const applied = await this.repo.saveStepCompleted(requestId, this.workerId, steps, LEASE_TTL_MS);
    if (!applied) throw new DeletionLeaseLostError();
  }

  private async executeStep(
    step: DeletionStep,
    request: DeletionRequestRecord,
    steps: StepsMap,
    exceptSessionId?: string,
  ): Promise<unknown> {
    const memberId = request.memberId;
    switch (step) {
      case 'quiesce':
        // Freeze-stamp + revoke every OTHER session + kill push channels,
        // idempotently, before anything destructive. A user retry passes
        // its driving session (which survives); a cron resume passes none,
        // so a request that never managed to quiesce freezes every device.
        await this.identity.quiesce(request.userId, exceptSessionId);
        if (!memberId) return null;
        return this.notifications.purgeForMember(memberId);

      case 'cancel_reservations':
        if (!memberId) return { skipped: 'no member profile' };
        return this.reservations.cancelFutureReservationsForMember(memberId, memberId);

      case 'release_participations':
        if (!memberId) return { skipped: 'no member profile' };
        return this.reservations.releaseParticipationsForMember(memberId, memberId);

      case 'close_billing':
        if (!memberId) return { skipped: 'no member profile' };
        return this.billing.closeBillingForMember(memberId);

      case 'release_clubs':
        if (!memberId) return { skipped: 'no member profile' };
        return this.clubs.releaseMemberForAccountDeletion(memberId, memberId);

      case 'revoke_apple':
        return { outcome: await this.identity.revokeAppleTokens(request.userId) };

      case 'erase_credentials':
        await this.identity.eraseCredentials(request.userId, request.emailAtRequest);
        return null;

      case 'tombstone_user':
        await this.identity.tombstoneUser(request.userId);
        return null;

      case 'scrub_member':
        if (!memberId) return { skipped: 'no member profile' };
        await this.members.scrubMember(memberId);
        // Belt and braces: a device registered mid-pipeline dies here too.
        await this.notifications.purgeForMember(memberId);
        return null;

      case 'purge_id_verification':
        if (!memberId) return { skipped: 'no member profile' };
        return this.members.purgeIdVerification(memberId);

      case 'finalize': {
        const when = new Date();
        await this.uow.execute(async (tx) => {
          steps.finalize = { ...steps.finalize, completedAt: when.toISOString() };
          // The outbox row (package F's consumers) and the completed flip
          // commit atomically: a deletion is never announced unfinished.
          await this.audit.append(tx, {
            streamType: 'user',
            streamId: request.userId,
            eventType: 'account.deleted',
            data: {
              memberId,
              memberNumber: request.memberNumberAtRequest,
              stepUpMethod: request.stepUpMethod,
              requestedAt: request.requestedAt.toISOString(),
              steps: summarizeResults(steps),
            },
            actorId: request.requestedByUserId,
          });
          // Compare-and-set on the lease INSIDE the same transaction: a
          // stolen lease rolls the event above back too, so two workers
          // racing the tail can never double-emit account.deleted.
          const applied = await this.repo.completeInTx(tx, request.id, this.workerId, steps, when);
          if (!applied) throw new DeletionLeaseLostError();
        });
        return null;
      }

      default: {
        const unhandled: never = step;
        throw new Error(`Unhandled deletion step: ${String(unhandled)}`);
      }
    }
  }

  private async handleStepFailure(
    request: DeletionRequestRecord,
    steps: StepsMap,
    step: DeletionStep,
    err: unknown,
  ): Promise<DeletionOutcome> {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    steps[step] = {
      ...steps[step],
      attempts: (steps[step]?.attempts ?? 0) + 1,
      lastError: message,
    };

    // A hard billing block (open dispute) is terminal until staff resolve
    // it; so is a runaway retry count. Both stop the cron and alert.
    const blocked =
      isAccountClosureBlocked(err) || request.attempts + 1 >= MAX_DELETION_ATTEMPTS;
    if (blocked) {
      const reasons = isAccountClosureBlocked(err)
        ? (err as { reasons: string[] }).reasons
        : [`retry limit reached at step ${step}: ${message}`];
      if (!(await this.repo.markBlocked(request.id, this.workerId, reasons, steps))) {
        // Lease stolen while handling the failure: the thief drives (and
        // will hit the same block itself if it is real).
        return { status: 'in_progress', requestId: request.id };
      }
      await this.uow.execute(async (tx) => {
        await this.audit.append(tx, {
          streamType: 'user',
          streamId: request.userId,
          eventType: 'account.deletion_blocked',
          data: { step, reasons },
          actorId: request.requestedByUserId,
        });
      });
      return { status: 'blocked', requestId: request.id, blockedReasons: reasons };
    }

    const attempts = request.attempts + 1;
    const applied = await this.repo.recordFailure(
      request.id,
      this.workerId,
      steps,
      attempts,
      new Date(Date.now() + nextAttemptDelayMs(attempts)),
    );
    if (!applied) return { status: 'in_progress', requestId: request.id };
    return { status: 'failed', requestId: request.id };
  }
}

function isAccountClosureBlocked(err: unknown): err is { reasons: string[] } {
  return (
    err instanceof Error &&
    err.name === 'AccountClosureBlockedError' &&
    Array.isArray((err as unknown as { reasons?: unknown }).reasons)
  );
}

function summarizeResults(steps: StepsMap): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(steps).map(([step, state]) => [step, state?.result ?? null]),
  );
}
