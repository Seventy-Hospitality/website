import { MemberRepository } from './member.repository';

/**
 * Pins the repository contracts around the member number and the
 * account-deletion scrub: a random member-number collision retries with a
 * fresh candidate (any OTHER unique violation propagates), and the scrub
 * anonymizes everything personal while keeping the row, the number and the
 * Stripe linkage.
 */

function p2002(target: string[]) {
  return { code: 'P2002', meta: { target } };
}

describe('MemberRepository.create', () => {
  it('retries with a fresh member number on a number collision', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(p2002(['memberNumber']))
      .mockImplementationOnce(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'mem_1', ...data }),
      );
    const repo = new MemberRepository({ member: { create } } as any);

    const member = await repo.create({ email: 'a@example.com', firstName: 'A', lastName: 'B' });

    expect(create).toHaveBeenCalledTimes(2);
    expect(member.memberNumber).toMatch(/^[A-HJ-NP-Z][0-9]{5}$/);
    const first = create.mock.calls[0][0].data.memberNumber;
    const second = create.mock.calls[1][0].data.memberNumber;
    expect(first).not.toBe(second);
  });

  it('propagates an email unique violation instead of retrying', async () => {
    const create = vi.fn().mockRejectedValue(p2002(['email']));
    const repo = new MemberRepository({ member: { create } } as any);

    await expect(repo.create({ email: 'a@example.com', firstName: 'A', lastName: 'B' })).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('MemberRepository.scrubForAccountDeletion', () => {
  it('anonymizes PII, tombstones the email, unlinks the user and keeps the row', async () => {
    const findUnique = vi.fn().mockResolvedValue({ avatarUrl: '/uploads/avatars/x.webp', deletedAt: null });
    const update = vi.fn().mockResolvedValue({});
    const repo = new MemberRepository({ member: { findUnique, update } } as any);

    const now = new Date('2026-08-11T12:00:00Z');
    const result = await repo.scrubForAccountDeletion('mem_1', now);

    expect(result).toEqual({ previousAvatarUrl: '/uploads/avatars/x.webp' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mem_1' },
      data: {
        firstName: 'Deleted',
        lastName: 'Member',
        displayName: null,
        phone: null,
        email: 'deleted+mem_1@invalid',
        avatarUrl: null,
        userId: null,
        deletedAt: now,
      },
    });
    // The scrub never touches memberNumber or stripeCustomerId: the number
    // stays retired on the row and billing keeps its customer linkage.
    expect(update.mock.calls[0][0].data).not.toHaveProperty('memberNumber');
    expect(update.mock.calls[0][0].data).not.toHaveProperty('stripeCustomerId');
  });

  it('is idempotent: a second run keeps the original deletedAt', async () => {
    const originallyDeletedAt = new Date('2026-08-01T00:00:00Z');
    const findUnique = vi.fn().mockResolvedValue({ avatarUrl: null, deletedAt: originallyDeletedAt });
    const update = vi.fn().mockResolvedValue({});
    const repo = new MemberRepository({ member: { findUnique, update } } as any);

    await repo.scrubForAccountDeletion('mem_1');

    expect(update.mock.calls[0][0].data.deletedAt).toBe(originallyDeletedAt);
  });

  it('no-ops on a missing member', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const update = vi.fn();
    const repo = new MemberRepository({ member: { findUnique, update } } as any);

    const result = await repo.scrubForAccountDeletion('missing');

    expect(result).toEqual({ previousAvatarUrl: null });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('MemberRepository.searchByNamePrefix', () => {
  it('matches member-number prefixes (with or without #) and excludes deleted members', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new MemberRepository({ member: { findMany } } as any);

    await repo.searchByNamePrefix('#a123', 10);

    const where = findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toEqual(
      expect.arrayContaining([{ memberNumber: { startsWith: 'A123' } }]),
    );
  });

  it('does not add a member-number matcher for multi-word name queries', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new MemberRepository({ member: { findMany } } as any);

    await repo.searchByNamePrefix('june park', 10);

    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(1);
  });
});
