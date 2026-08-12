import { MemberClaimService, splitFullName } from './member-claiming';
import type { AuditLog, MemberDirectory } from './ports';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';

const TX = {} as TransactionContext;

function mockDirectory(
  memberByEmail: { id: string; userId: string | null; hasBilling?: boolean } | null = null,
): MemberDirectory {
  return {
    findByEmail: vi.fn().mockResolvedValue(
      memberByEmail ? { hasBilling: false, ...memberByEmail } : null,
    ),
    claim: vi.fn().mockResolvedValue(true),
    createForUser: vi.fn().mockResolvedValue({ id: 'mem_new' }),
  };
}

function mockAudit(): AuditLog {
  return { append: vi.fn().mockResolvedValue({ id: 'evt_1', seq: 1 }) };
}

describe('splitFullName', () => {
  it('splits first and last name', () => {
    expect(splitFullName('Alice Chen')).toEqual({ firstName: 'Alice', lastName: 'Chen' });
  });

  it('keeps middle names with the first name', () => {
    expect(splitFullName('Mary Jane Watson')).toEqual({ firstName: 'Mary Jane', lastName: 'Watson' });
  });

  it('handles a single name', () => {
    expect(splitFullName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });

  it('normalizes whitespace', () => {
    expect(splitFullName('  Alice   Chen  ')).toEqual({ firstName: 'Alice', lastName: 'Chen' });
  });
});

describe('MemberClaimService', () => {
  describe('claimIfEligible', () => {
    it('claims an unlinked member on a verified email and audits in-transaction', async () => {
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const audit = mockAudit();
      const service = new MemberClaimService(directory, audit);

      const result = await service.claimIfEligible(
        TX,
        { id: 'usr_1', email: 'alice@example.com', emailVerifiedAt: new Date() },
        { accountControlProven: false },
      );

      expect(result).toEqual({ claimedMemberId: 'mem_1' });
      expect(directory.claim).toHaveBeenCalledWith(TX, 'mem_1', 'usr_1');
      expect(audit.append).toHaveBeenCalledWith(TX, expect.objectContaining({
        streamType: 'member',
        streamId: 'mem_1',
        eventType: 'MemberClaimed',
        actorId: 'usr_1',
      }));
    });

    it('never claims from an unverified email', async () => {
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const service = new MemberClaimService(directory, mockAudit());

      const result = await service.claimIfEligible(
        TX,
        { id: 'usr_1', email: 'alice@example.com', emailVerifiedAt: null },
        { accountControlProven: true },
      );

      expect(result).toEqual({ claimedMemberId: null });
      expect(directory.claim).not.toHaveBeenCalled();
    });

    it('never claims a member already linked to a user', async () => {
      const directory = mockDirectory({ id: 'mem_1', userId: 'usr_other' });
      const service = new MemberClaimService(directory, mockAudit());

      const result = await service.claimIfEligible(
        TX,
        { id: 'usr_1', email: 'alice@example.com', emailVerifiedAt: new Date() },
        { accountControlProven: true },
      );

      expect(result).toEqual({ claimedMemberId: null });
      expect(directory.claim).not.toHaveBeenCalled();
    });

    it('withholds a billing-carrying row without proven account control', async () => {
      const directory = mockDirectory({ id: 'mem_1', userId: null, hasBilling: true });
      const service = new MemberClaimService(directory, mockAudit());

      const result = await service.claimIfEligible(
        TX,
        { id: 'usr_1', email: 'alice@example.com', emailVerifiedAt: new Date() },
        { accountControlProven: false },
      );

      expect(result).toEqual({ claimedMemberId: null });
      expect(directory.claim).not.toHaveBeenCalled();
    });

    it('claims a billing-carrying row when account control is proven', async () => {
      const directory = mockDirectory({ id: 'mem_1', userId: null, hasBilling: true });
      const service = new MemberClaimService(directory, mockAudit());

      const result = await service.claimIfEligible(
        TX,
        { id: 'usr_1', email: 'alice@example.com', emailVerifiedAt: new Date() },
        { accountControlProven: true },
      );

      expect(result).toEqual({ claimedMemberId: 'mem_1' });
      expect(directory.claim).toHaveBeenCalledWith(TX, 'mem_1', 'usr_1');
    });

    it('treats a lost claim race as a benign no-op, not a failure', async () => {
      // Another verification claimed the row microseconds earlier: claim
      // returns false, so no audit event and no thrown error abort the tx.
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      (directory.claim as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const audit = mockAudit();
      const service = new MemberClaimService(directory, audit);

      const result = await service.claimIfEligible(
        TX,
        { id: 'usr_1', email: 'alice@example.com', emailVerifiedAt: new Date() },
        { accountControlProven: true },
      );

      expect(result).toEqual({ claimedMemberId: null });
      expect(audit.append).not.toHaveBeenCalled();
    });
  });

  describe('createProfileIfAbsent', () => {
    it('creates a member profile linked to the user', async () => {
      const directory = mockDirectory(null);
      const service = new MemberClaimService(directory, mockAudit());

      const result = await service.createProfileIfAbsent(
        TX,
        { id: 'usr_1', email: 'alice@example.com' },
        { firstName: 'Alice', lastName: 'Chen', phone: '555-0101' },
      );

      expect(result).toEqual({ createdMemberId: 'mem_new' });
      expect(directory.createForUser).toHaveBeenCalledWith(TX, {
        userId: 'usr_1',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Chen',
        phone: '555-0101',
      });
    });

    it('creates nothing when a member row already matches the email', async () => {
      // That row is a claim candidate, resolved at email verification.
      const directory = mockDirectory({ id: 'mem_1', userId: null });
      const service = new MemberClaimService(directory, mockAudit());

      const result = await service.createProfileIfAbsent(
        TX,
        { id: 'usr_1', email: 'alice@example.com' },
        { firstName: 'Alice', lastName: 'Chen' },
      );

      expect(result).toEqual({ createdMemberId: null });
      expect(directory.createForUser).not.toHaveBeenCalled();
    });
  });
});
