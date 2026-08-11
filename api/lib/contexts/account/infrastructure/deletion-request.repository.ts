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
   * after the TTL).
   */
  async claimLease(id: string, workerId: string, ttlMs: number, now: Date = new Date()): Promise<boolean> {
    const result = await this.prisma.deletionRequest.updateMany({
      where: {
        id,
        status: { in: ['in_progress', 'failed'] },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { lockedBy: workerId, lockedUntil: new Date(now.getTime() + ttlMs), status: 'in_progress' },
    });
    return result.count === 1;
  }

  async releaseLease(id: string, workerId: string): Promise<void> {
    await this.prisma.deletionRequest.updateMany({
      where: { id, lockedBy: workerId },
      data: { lockedBy: null, lockedUntil: null },
    });
  }

  async saveStepCompleted(id: string, steps: StepsMap): Promise<void> {
    await this.prisma.deletionRequest.update({
      where: { id },
      data: { steps: steps as Prisma.InputJsonValue },
    });
  }

  async recordFailure(
    id: string,
    steps: StepsMap,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.prisma.deletionRequest.update({
      where: { id },
      data: {
        steps: steps as Prisma.InputJsonValue,
        attempts,
        nextAttemptAt,
        status: 'failed',
        lockedBy: null,
        lockedUntil: null,
      },
    });
  }

  async markBlocked(id: string, reasons: string[], steps: StepsMap): Promise<void> {
    await this.prisma.deletionRequest.update({
      where: { id },
      data: {
        status: 'blocked',
        blockedReasons: reasons,
        steps: steps as Prisma.InputJsonValue,
        nextAttemptAt: null,
        lockedBy: null,
        lockedUntil: null,
      },
    });
  }

  /** Completion rides the finalize step's transaction (audit + outbox row). */
  async completeInTx(tx: TransactionContext, id: string, steps: StepsMap, when: Date): Promise<void> {
    await asPrismaTx(tx).deletionRequest.update({
      where: { id },
      data: {
        status: 'completed',
        completedAt: when,
        steps: steps as Prisma.InputJsonValue,
        nextAttemptAt: null,
        lockedBy: null,
        lockedUntil: null,
      },
    });
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
