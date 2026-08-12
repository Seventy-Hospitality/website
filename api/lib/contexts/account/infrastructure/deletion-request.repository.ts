import type { PrismaClient, Prisma } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import type { DeletionRequestStatus, StepsMap } from '../domain';

export interface DeletionRequestRecord {
  id: string;
  userId: string;
  memberId: string | null;
  requestedByUserId: string;
  status: DeletionRequestStatus;
  steps: StepsMap;
  stepsVersion: number;
  attempts: number;
  nextAttemptAt: Date | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  blockedReasons: string[];
  stepUpMethod: string;
  client: string | null;
  ip: string | null;
  emailAtRequest: string;
  memberNumberAtRequest: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}

function toRecord(row: any): DeletionRequestRecord {
  return { ...row, steps: (row.steps ?? {}) as StepsMap };
}

export class DeletionRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByUserId(userId: string): Promise<DeletionRequestRecord | null> {
    const row = await this.prisma.deletionRequest.findUnique({ where: { userId } });
    return row && toRecord(row);
  }

  async findById(id: string): Promise<DeletionRequestRecord | null> {
    const row = await this.prisma.deletionRequest.findUnique({ where: { id } });
    return row && toRecord(row);
  }

  async create(input: {
    userId: string;
    memberId: string | null;
    requestedByUserId: string;
    stepsVersion: number;
    stepUpMethod: string;
    client: string | null;
    ip: string | null;
    emailAtRequest: string;
    memberNumberAtRequest: string | null;
  }): Promise<DeletionRequestRecord> {
    const row = await this.prisma.deletionRequest.create({ data: input });
    return toRecord(row);
  }

  /**
   * Leases the request to one worker: a user retry and the resume cron can
   * never drive the same saga concurrently. Claim succeeds when unleased
   * or the previous lease expired (a run killed mid-flight is re-drivable
   * after the TTL). Answers the freshly-leased record — the ONLY snapshot
   * a run may drive from (re-reading after the claim closes the window
   * where a worker seeds its steps from a stale pre-claim read) — or null
   * when another worker holds the lease.
   */
  async claimLease(
    id: string,
    workerId: string,
    ttlMs: number,
    now: Date = new Date(),
  ): Promise<DeletionRequestRecord | null> {
    const result = await this.prisma.deletionRequest.updateMany({
      where: {
        id,
        status: { in: ['in_progress', 'failed'] },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { lockedBy: workerId, lockedUntil: new Date(now.getTime() + ttlMs), status: 'in_progress' },
    });
    if (result.count !== 1) return null;
    const row = await this.prisma.deletionRequest.findUnique({ where: { id } });
    return row && toRecord(row);
  }

  async releaseLease(id: string, workerId: string): Promise<void> {
    await this.prisma.deletionRequest.updateMany({
      where: { id, lockedBy: workerId },
      data: { lockedBy: null, lockedUntil: null },
    });
  }

  /**
   * Persists a completed step IF this worker still holds the lease, and
   * renews the lease in the same write (heartbeat): a slow-but-alive run
   * keeps its claim as long as it keeps finishing steps, however long the
   * whole pipeline takes. 0 rows = the lease expired mid-step and another
   * worker stole it; the caller must abandon the run (steps are
   * idempotent, so the thief re-driving them is safe — two workers
   * WRITING is not).
   */
  async saveStepCompleted(
    id: string,
    workerId: string,
    steps: StepsMap,
    ttlMs: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.deletionRequest.updateMany({
      where: { id, lockedBy: workerId },
      data: {
        steps: steps as Prisma.InputJsonValue,
        lockedUntil: new Date(now.getTime() + ttlMs),
      },
    });
    return result.count === 1;
  }

  /** Lease-guarded like saveStepCompleted; 0 rows = abandon, the thief drives. */
  async recordFailure(
    id: string,
    workerId: string,
    steps: StepsMap,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.deletionRequest.updateMany({
      where: { id, lockedBy: workerId },
      data: {
        steps: steps as Prisma.InputJsonValue,
        attempts,
        nextAttemptAt,
        status: 'failed',
        lockedBy: null,
        lockedUntil: null,
      },
    });
    return result.count === 1;
  }

  /** Lease-guarded like saveStepCompleted; 0 rows = abandon, the thief drives. */
  async markBlocked(id: string, workerId: string, reasons: string[], steps: StepsMap): Promise<boolean> {
    const result = await this.prisma.deletionRequest.updateMany({
      where: { id, lockedBy: workerId },
      data: {
        status: 'blocked',
        blockedReasons: reasons,
        steps: steps as Prisma.InputJsonValue,
        nextAttemptAt: null,
        lockedBy: null,
        lockedUntil: null,
      },
    });
    return result.count === 1;
  }

  /**
   * Completion rides the finalize step's transaction (audit + outbox row),
   * compare-and-set on the lease AND the status: 0 rows (lease stolen, or
   * the thief already completed) tells the caller to roll the transaction
   * back — including its account.deleted event, which is therefore emitted
   * exactly once per request. The completed row also sheds its PII: the
   * plaintext emailAtRequest existed solely for erase_credentials (magic
   * links key on email) and the ip for request provenance; after
   * completion a "deleted" account's real email and IP must not survive in
   * a retained row the tombstones scrubbed everywhere else.
   */
  async completeInTx(
    tx: TransactionContext,
    id: string,
    workerId: string,
    steps: StepsMap,
    when: Date,
  ): Promise<boolean> {
    const result = await asPrismaTx(tx).deletionRequest.updateMany({
      where: { id, lockedBy: workerId, status: { not: 'completed' } },
      data: {
        status: 'completed',
        completedAt: when,
        steps: steps as Prisma.InputJsonValue,
        nextAttemptAt: null,
        lockedBy: null,
        lockedUntil: null,
        emailAtRequest: '',
        ip: null,
      },
    });
    return result.count === 1;
  }

  /** Requests the resume cron should re-drive. */
  async listDue(limit: number, now: Date = new Date()): Promise<DeletionRequestRecord[]> {
    const rows = await this.prisma.deletionRequest.findMany({
      where: {
        status: { in: ['in_progress', 'failed'] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        AND: [{ OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }],
      },
      orderBy: { requestedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }
}
