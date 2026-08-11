import type { UnitOfWork } from '@/lib/kernel';
import { DELETION_STEPS } from '../domain';
import type { DeletionRequestRecord, DeletionRequestRepository } from '../infrastructure/deletion-request.repository';
import { AccountDeletionService } from './deletion.service';
import type {
  AuditLog,
  BillingClosurePort,
  ClubsReleasePort,
  IdentityErasurePort,
  MemberErasurePort,
  NotificationPurgePort,
  ReservationReleasePort,
} from './ports';

class AccountClosureBlockedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Account closure blocked: ${reasons.join(', ')}`);
    this.name = 'AccountClosureBlockedError';
  }
}

function requestRecord(overrides: Partial<DeletionRequestRecord> = {}): DeletionRequestRecord {
  return {
    id: 'del_1',
    userId: 'usr_1',
    memberId: 'mem_1',
    requestedByUserId: 'usr_1',
    status: 'in_progress',
    steps: {},
    stepsVersion: 1,
    attempts: 0,
    nextAttemptAt: null,
    lockedBy: null,
    lockedUntil: null,
    blockedReasons: [],
    stepUpMethod: 'password',
    client: 'member_mobile',
    ip: null,
    emailAtRequest: 'alice@example.com',
    memberNumberAtRequest: 'A12345',
    requestedAt: new Date('2026-08-11T12:00:00Z'),
    completedAt: null,
    updatedAt: new Date('2026-08-11T12:00:00Z'),
    ...overrides,
  };
}

/** In-memory repository double faithful to the persistence contract. */
function fakeRepo(existing: DeletionRequestRecord | null = null) {
  let row = existing;
  const repo = {
    findByUserId: vi.fn(async () => row),
    findById: vi.fn(async () => row),
    create: vi.fn(async (input: any) => {
      row = requestRecord({ ...input, id: 'del_1', steps: {} });
      return row!;
    }),
    claimLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => {}),
    saveStepCompleted: vi.fn(async (_id: string, steps: any) => {
      row = { ...row!, steps: structuredClone(steps) };
    }),
    recordFailure: vi.fn(async (_id: string, steps: any, attempts: number, nextAttemptAt: Date) => {
      row = { ...row!, steps: structuredClone(steps), attempts, nextAttemptAt, status: 'failed' };
    }),
    markBlocked: vi.fn(async (_id: string, reasons: string[], steps: any) => {
      row = { ...row!, status: 'blocked', blockedReasons: reasons, steps: structuredClone(steps) };
    }),
    completeInTx: vi.fn(async (_tx: unknown, _id: string, steps: any, when: Date) => {
      row = { ...row!, status: 'completed', completedAt: when, steps: structuredClone(steps) };
    }),
    listDue: vi.fn(async () => (row && (row.status === 'in_progress' || row.status === 'failed') ? [row] : [])),
    current: () => row,
  };
  return repo;
}

function mockPorts() {
  return {
    billing: {
      assertClosable: vi.fn().mockResolvedValue(undefined),
      closeBillingForMember: vi.fn().mockResolvedValue({ subscriptionCanceled: true, paymentMethodsDetached: 1 }),
    } satisfies BillingClosurePort,
    reservations: {
      cancelFutureReservationsForMember: vi.fn().mockResolvedValue({ cancelled: 2, refundCents: 4000 }),
      releaseParticipationsForMember: vi.fn().mockResolvedValue({ released: 1 }),
    } satisfies ReservationReleasePort,
    clubs: {
      releaseMemberForAccountDeletion: vi.fn().mockResolvedValue({ leftClubIds: ['clb_1'] }),
    } satisfies ClubsReleasePort,
    identity: {
      quiesce: vi.fn().mockResolvedValue(undefined),
      revokeAppleTokens: vi.fn().mockResolvedValue('not_applicable'),
      eraseCredentials: vi.fn().mockResolvedValue(undefined),
      tombstoneUser: vi.fn().mockResolvedValue(undefined),
    } satisfies IdentityErasurePort,
    members: {
      getMemberNumber: vi.fn().mockResolvedValue('A12345'),
      scrubMember: vi.fn().mockResolvedValue(undefined),
      purgeIdVerification: vi.fn().mockResolvedValue({ photoDeleted: true }),
    } satisfies MemberErasurePort,
    notifications: {
      purgeForMember: vi.fn().mockResolvedValue({ devicesDeleted: 2 }),
    } satisfies NotificationPurgePort,
  };
}

function build(repo: ReturnType<typeof fakeRepo>, ports = mockPorts()) {
  const audit: AuditLog = { append: vi.fn().mockResolvedValue({}) };
  const uow = { execute: vi.fn(async (fn: any) => fn({})) } as unknown as UnitOfWork;
  const service = new AccountDeletionService(
    repo as unknown as DeletionRequestRepository,
    ports.billing,
    ports.reservations,
    ports.clubs,
    ports.identity,
    ports.members,
    ports.notifications,
    audit,
    uow,
  );
  return { service, ports, audit, uow };
}

const INPUT = {
  userId: 'usr_1',
  memberId: 'mem_1',
  sessionId: 'ses_1',
  email: 'alice@example.com',
  stepUpMethod: 'password',
  client: 'member_mobile',
  ip: '1.2.3.4',
};

describe('AccountDeletionService happy path', () => {
  it('gates on assertClosable, quiesces, runs every step in order, finalizes atomically', async () => {
    const repo = fakeRepo();
    const { service, ports, audit } = build(repo);
    const calls: string[] = [];
    ports.billing.assertClosable.mockImplementation(async () => void calls.push('assertClosable'));
    ports.identity.quiesce.mockImplementation(async () => void calls.push('quiesce'));
    ports.reservations.cancelFutureReservationsForMember.mockImplementation(async () => {
      calls.push('cancel_reservations');
      return { cancelled: 2, refundCents: 4000 };
    });
    ports.reservations.releaseParticipationsForMember.mockImplementation(async () => {
      calls.push('release_participations');
      return { released: 1 };
    });
    ports.billing.closeBillingForMember.mockImplementation(async () => {
      calls.push('close_billing');
      return { subscriptionCanceled: true, paymentMethodsDetached: 1 };
    });
    ports.clubs.releaseMemberForAccountDeletion.mockImplementation(async () => {
      calls.push('release_clubs');
      return {};
    });
    ports.identity.revokeAppleTokens.mockImplementation(async () => {
      calls.push('revoke_apple');
      return 'revoked';
    });
    ports.identity.eraseCredentials.mockImplementation(async () => void calls.push('erase_credentials'));
    ports.identity.tombstoneUser.mockImplementation(async () => void calls.push('tombstone_user'));
    ports.members.scrubMember.mockImplementation(async () => void calls.push('scrub_member'));
    ports.members.purgeIdVerification.mockImplementation(async () => {
      calls.push('purge_id_verification');
      return { photoDeleted: true };
    });

    const outcome = await service.request(INPUT);

    expect(outcome.status).toBe('completed');
    expect(calls).toEqual([
      'assertClosable',
      'quiesce',
      'cancel_reservations',
      'release_participations',
      'close_billing',
      'release_clubs',
      'revoke_apple',
      'erase_credentials',
      'tombstone_user',
      'scrub_member',
      'purge_id_verification',
    ]);
    // The other-sessions revocation carried the driving session exception.
    expect(ports.identity.quiesce).toHaveBeenCalledWith('usr_1', 'ses_1');
    // Credentials were erased with the PRE-tombstone email.
    expect(ports.identity.eraseCredentials).toHaveBeenCalledWith('usr_1', 'alice@example.com');
    // The outbox event and completion committed together (finalize step).
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'account.deleted',
      streamId: 'usr_1',
      data: expect.objectContaining({ memberId: 'mem_1', memberNumber: 'A12345' }),
    }));
    expect(repo.completeInTx).toHaveBeenCalled();
    expect(repo.current()?.status).toBe('completed');
    // Every step recorded completion.
    for (const step of DELETION_STEPS) {
      expect(repo.current()?.steps[step]?.completedAt, step).toBeTruthy();
    }
  });

  it('an account with no member profile skips the member-scoped steps', async () => {
    const repo = fakeRepo();
    const { service, ports } = build(repo);

    const outcome = await service.request({ ...INPUT, memberId: null });

    expect(outcome.status).toBe('completed');
    expect(ports.billing.assertClosable).not.toHaveBeenCalled();
    expect(ports.billing.closeBillingForMember).not.toHaveBeenCalled();
    expect(ports.reservations.cancelFutureReservationsForMember).not.toHaveBeenCalled();
    expect(ports.clubs.releaseMemberForAccountDeletion).not.toHaveBeenCalled();
    expect(ports.identity.eraseCredentials).toHaveBeenCalled();
    expect(ports.identity.tombstoneUser).toHaveBeenCalled();
  });
});

describe('AccountDeletionService blocking', () => {
  it('propagates the entry gate untouched (nothing persisted)', async () => {
    const repo = fakeRepo();
    const ports = mockPorts();
    ports.billing.assertClosable.mockRejectedValue(new AccountClosureBlockedError(['a refund in flight']));
    const { service } = build(repo, ports);

    await expect(service.request(INPUT)).rejects.toThrow('Account closure blocked');
    expect(repo.create).not.toHaveBeenCalled();
    expect(ports.identity.quiesce).not.toHaveBeenCalled();
  });

  it('a dispute arriving mid-pipeline re-blocks at close_billing (status blocked, alert)', async () => {
    const repo = fakeRepo();
    const ports = mockPorts();
    ports.billing.closeBillingForMember.mockRejectedValue(new AccountClosureBlockedError(['an open payment dispute']));
    const { service, audit } = build(repo, ports);

    const outcome = await service.request(INPUT);

    expect(outcome.status).toBe('blocked');
    expect(outcome.blockedReasons).toEqual(['an open payment dispute']);
    expect(repo.current()?.status).toBe('blocked');
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'account.deletion_blocked',
    }));
    // Earlier steps stay completed for the eventual staff-resolved resume.
    expect(repo.current()?.steps.cancel_reservations?.completedAt).toBeTruthy();
  });
});

describe('AccountDeletionService resumability', () => {
  it('a mid-pipeline Stripe failure persists progress; the re-run skips completed steps', async () => {
    const repo = fakeRepo();
    const ports = mockPorts();
    ports.billing.closeBillingForMember.mockRejectedValueOnce(new Error('stripe unavailable'));
    const { service } = build(repo, ports);

    const first = await service.request(INPUT);
    expect(first.status).toBe('failed');
    expect(repo.current()?.steps.cancel_reservations?.completedAt).toBeTruthy();
    expect(repo.current()?.steps.close_billing?.completedAt).toBeUndefined();
    expect(repo.current()?.steps.close_billing?.lastError).toContain('stripe unavailable');
    expect(repo.current()?.nextAttemptAt).toBeInstanceOf(Date);

    // Retry (same DELETE or the cron): earlier steps are NOT re-executed.
    const second = await service.request(INPUT);
    expect(second.status).toBe('completed');
    expect(ports.reservations.cancelFutureReservationsForMember).toHaveBeenCalledTimes(1);
    expect(ports.billing.closeBillingForMember).toHaveBeenCalledTimes(2);
    // The resume did NOT re-run the entry gate: the pipeline's own pending
    // refunds must not wedge it.
    expect(ports.billing.assertClosable).toHaveBeenCalledTimes(1);
    // Quiesce ran once, at creation.
    expect(ports.identity.quiesce).toHaveBeenCalledTimes(1);
  });

  it('an Apple transient failure retries revoke WITHOUT re-deleting anything', async () => {
    const repo = fakeRepo();
    const ports = mockPorts();
    ports.identity.revokeAppleTokens
      .mockRejectedValueOnce(new Error('apple 500'))
      .mockResolvedValueOnce('revoked');
    const { service } = build(repo, ports);

    expect((await service.request(INPUT)).status).toBe('failed');
    // The identity rows survived the failed revoke for the retry.
    expect(ports.identity.eraseCredentials).not.toHaveBeenCalled();

    expect((await service.request(INPUT)).status).toBe('completed');
    expect(ports.identity.revokeAppleTokens).toHaveBeenCalledTimes(2);
    expect(ports.identity.eraseCredentials).toHaveBeenCalledTimes(1);
  });

  it('resumeDue drives due requests to completion (the cron path)', async () => {
    const repo = fakeRepo();
    const ports = mockPorts();
    ports.members.scrubMember.mockRejectedValueOnce(new Error('db hiccup'));
    const { service } = build(repo, ports);

    expect((await service.request(INPUT)).status).toBe('failed');

    const summary = await service.resumeDue(10, new Date(Date.now() + 10 * 60_000));
    expect(summary).toEqual({ resumed: 1, completed: 1, blocked: 0, failed: 0 });
    expect(repo.current()?.status).toBe('completed');
  });

  it('flips to blocked (with alert) once the retry cap is reached', async () => {
    const repo = fakeRepo(requestRecord({ attempts: 19 }));
    const ports = mockPorts();
    ports.reservations.cancelFutureReservationsForMember.mockRejectedValue(new Error('still down'));
    const { service, audit } = build(repo, ports);

    const outcome = await service.request(INPUT);

    expect(outcome.status).toBe('blocked');
    expect(outcome.blockedReasons?.[0]).toContain('retry limit reached');
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'account.deletion_blocked',
    }));
  });
});

describe('AccountDeletionService concurrency and idempotence', () => {
  it('a completed request answers idempotently without running anything', async () => {
    const repo = fakeRepo(requestRecord({ status: 'completed', completedAt: new Date() }));
    const { service, ports } = build(repo);

    const outcome = await service.request(INPUT);

    expect(outcome.status).toBe('completed');
    expect(ports.identity.quiesce).not.toHaveBeenCalled();
    expect(ports.billing.closeBillingForMember).not.toHaveBeenCalled();
  });

  it('an existing request resumes WITHOUT re-verifying step-up or re-quiescing', async () => {
    const repo = fakeRepo(requestRecord());
    const { service, ports } = build(repo);

    const outcome = await service.request(INPUT);

    expect(outcome.status).toBe('completed');
    expect(ports.identity.quiesce).not.toHaveBeenCalled(); // creation-only
    expect(ports.billing.assertClosable).not.toHaveBeenCalled();
  });

  it('a lease held by another worker yields in_progress without touching steps', async () => {
    const repo = fakeRepo(requestRecord());
    repo.claimLease.mockResolvedValue(false);
    const { service, ports } = build(repo);

    const outcome = await service.request(INPUT);

    expect(outcome.status).toBe('in_progress');
    expect(ports.reservations.cancelFutureReservationsForMember).not.toHaveBeenCalled();
  });

  it('two racing creations adopt the winner row via the unique userId', async () => {
    const repo = fakeRepo();
    const winner = requestRecord();
    repo.create.mockRejectedValue({ code: 'P2002' });
    repo.findByUserId
      .mockResolvedValueOnce(null) // initial lookup: nothing yet
      .mockResolvedValue(winner); // post-conflict re-read
    const { service } = build(repo);

    const outcome = await service.request(INPUT);
    expect(outcome.status).toBe('completed');
  });
});
