import { ClubRepository } from './club.repository';
import type { TransactionContext } from '@/lib/kernel';

/**
 * The account-deletion seam withdraws pending invitations in clubs the
 * member may have already LEFT, which the per-club advisory-lock loop does
 * not cover. These tests pin the repository contract that keeps that safe:
 * every revoke is a compare-and-set guarded on status = 'pending', and a
 * row a concurrent accept claimed first is skipped AND absent from the
 * returned list (so no invitation_withdrawn audit event is emitted for an
 * invitation that was actually accepted).
 */

const RESPONDED_AT = new Date('2026-08-10T12:00:00Z');

function pendingRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    clubId: 'clb_1',
    inviterId: 'mem_gone',
    inviteeMemberId: 'mem_9',
    status: 'pending',
    respondedAt: null,
    createdAt: RESPONDED_AT,
    updatedAt: RESPONDED_AT,
    ...overrides,
  };
}

function txWith(rows: unknown[], counts: number[]) {
  const updateMany = vi.fn();
  for (const count of counts) updateMany.mockResolvedValueOnce({ count });
  return {
    tx: {
      clubInvitation: {
        findMany: vi.fn().mockResolvedValue(rows),
        updateMany,
      },
    },
    updateMany,
  };
}

describe('ClubRepository invitation withdrawal (account-deletion seam)', () => {
  it('revokes each SENT invitation with a status-pending compare-and-set', async () => {
    const { tx, updateMany } = txWith([pendingRow('inv_1'), pendingRow('inv_2')], [1, 1]);
    const repo = new ClubRepository({} as never);

    const revoked = await repo.withdrawPendingInvitationsBy(
      tx as unknown as TransactionContext,
      'mem_gone',
      RESPONDED_AT,
    );

    expect(tx.clubInvitation.findMany).toHaveBeenCalledWith({
      where: { inviterId: 'mem_gone', status: 'pending' },
    });
    // The guard on the WRITE is the fix: without it, a row a concurrent
    // accept already moved to 'accepted' would be clobbered to 'revoked'.
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'inv_1', status: 'pending' },
      data: { status: 'revoked', respondedAt: RESPONDED_AT },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'inv_2', status: 'pending' },
      data: { status: 'revoked', respondedAt: RESPONDED_AT },
    });
    expect(revoked.map((row) => row.id)).toEqual(['inv_1', 'inv_2']);
    expect(revoked.every((row) => row.status === 'revoked')).toBe(true);
  });

  it('revokes RECEIVED invitations under the same compare-and-set', async () => {
    const { tx, updateMany } = txWith([pendingRow('inv_1', { inviteeMemberId: 'mem_gone' })], [1]);
    const repo = new ClubRepository({} as never);

    const revoked = await repo.withdrawPendingInvitationsTo(
      tx as unknown as TransactionContext,
      'mem_gone',
      RESPONDED_AT,
    );

    expect(tx.clubInvitation.findMany).toHaveBeenCalledWith({
      where: { inviteeMemberId: 'mem_gone', status: 'pending' },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'inv_1', status: 'pending' },
      data: { status: 'revoked', respondedAt: RESPONDED_AT },
    });
    expect(revoked).toHaveLength(1);
  });

  it('omits a row a concurrent accept won, so it is never reported withdrawn', async () => {
    // inv_raced left 'pending' between the read and the write (the invitee
    // accepted); its CAS updates 0 rows and it must not appear in the
    // result the service audits from.
    const { tx } = txWith([pendingRow('inv_kept'), pendingRow('inv_raced')], [1, 0]);
    const repo = new ClubRepository({} as never);

    const revoked = await repo.withdrawPendingInvitationsBy(
      tx as unknown as TransactionContext,
      'mem_gone',
      RESPONDED_AT,
    );

    expect(revoked.map((row) => row.id)).toEqual(['inv_kept']);
  });

  it('touches nothing when the member has no pending invitations', async () => {
    const { tx, updateMany } = txWith([], []);
    const repo = new ClubRepository({} as never);

    const revoked = await repo.withdrawPendingInvitationsBy(
      tx as unknown as TransactionContext,
      'mem_gone',
      RESPONDED_AT,
    );

    expect(revoked).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
