import { ReservationRepository } from './reservation.repository';
import { isClaimConflictError } from './pg-errors';
import { SlotUnavailableError } from '../domain';
import type { TransactionContext } from '@/lib/kernel';

/**
 * The exclusion constraint can only fire against a real Postgres; these
 * tests pin the REPOSITORY contract instead: every shape Prisma uses to
 * surface a lost claim race (SQLSTATE 23P01, or 40P01 when both conflicting
 * inserts were mid-flight in the GiST index) must map to
 * SlotUnavailableError, never a 500. The full end-to-end race is exercised
 * against a scratch database by the migration validation run (see
 * docs/decisions-scheduling.md).
 */

function p2010(code: string) {
  const error = new Error(`Raw query failed. Code: \`${code}\``);
  return Object.assign(error, { code: 'P2010', meta: { code } });
}

describe('isClaimConflictError', () => {
  it('matches P2010 raw-query failures carrying the sqlstate', () => {
    expect(isClaimConflictError(p2010('23P01'))).toBe(true);
  });

  it('matches a deadlock between two mid-flight conflicting inserts', () => {
    expect(isClaimConflictError(p2010('40P01'))).toBe(true);
    expect(isClaimConflictError(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(true);
  });

  it('matches driver-adapter errors with the pg code on the cause', () => {
    const error = new Error('exclusion violation');
    (error as Error & { cause: unknown }).cause = { code: '23P01' };
    expect(isClaimConflictError(error)).toBe(true);
  });

  it('matches by constraint name in the message', () => {
    expect(
      isClaimConflictError(new Error('conflicting key value violates exclusion constraint "no_overlapping_claims"')),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isClaimConflictError(new Error('connection refused'))).toBe(false);
    expect(isClaimConflictError(p2010('23505'))).toBe(false);
    expect(isClaimConflictError(null)).toBe(false);
  });
});

describe('ReservationRepository claim writes', () => {
  const input = {
    resourceTypeId: 'rt_1',
    resourceId: 'r1',
    organizerId: 'mem_1',
    startsAt: new Date('2026-07-02T22:00:00Z'),
    endsAt: new Date('2026-07-02T23:00:00Z'),
    localDate: '2026-07-02',
    status: 'pending_payment' as const,
    hourlyRateCentsSnapshot: 2000,
    holdExpiresAt: new Date('2026-07-01T12:12:00Z'),
    participants: [{ memberId: 'mem_1', role: 'organizer' as const, status: 'confirmed' as const }],
  };

  it('maps a 23P01 on the claim INSERT to SlotUnavailableError', async () => {
    const tx = {
      reservation: { create: vi.fn().mockResolvedValue({ id: 'rsv_1' }) },
      $executeRaw: vi.fn().mockRejectedValue(p2010('23P01')),
    } as unknown as TransactionContext;

    const repo = new ReservationRepository({} as never);
    await expect(repo.createWithClaim(tx, input)).rejects.toThrow(SlotUnavailableError);
  });

  it('maps a 23P01 on the claim UPDATE (reschedule) to SlotUnavailableError', async () => {
    const tx = {
      $executeRaw: vi.fn().mockRejectedValue(p2010('23P01')),
    } as unknown as TransactionContext;

    const repo = new ReservationRepository({} as never);
    await expect(
      repo.moveClaimAndReservation(tx, {
        reservationId: 'rsv_1',
        resourceId: 'r1',
        startsAt: new Date(),
        endsAt: new Date(),
        localDate: '2026-07-02',
      }),
    ).rejects.toThrow(SlotUnavailableError);
  });

  it('rethrows non-conflict failures untouched', async () => {
    const boom = new Error('connection reset');
    const tx = {
      reservation: { create: vi.fn().mockResolvedValue({ id: 'rsv_1' }) },
      $executeRaw: vi.fn().mockRejectedValue(boom),
    } as unknown as TransactionContext;

    const repo = new ReservationRepository({} as never);
    await expect(repo.createWithClaim(tx, input)).rejects.toBe(boom);
  });
});
