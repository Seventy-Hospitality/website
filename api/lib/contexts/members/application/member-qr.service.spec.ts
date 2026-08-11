import { createHash } from 'crypto';
import { MemberNotFoundError, QrTokenError } from '../domain';
import type { MemberRepository } from '../infrastructure';
import { MemberQrService } from './member-qr.service';

const KEY = createHash('sha256').update('test:member-qr').digest();

function repoWith(member: unknown): MemberRepository {
  return { getById: vi.fn().mockResolvedValue(member) } as unknown as MemberRepository;
}

const MEMBER = {
  id: 'mem_1',
  memberNumber: 'A12345',
  firstName: 'Alice',
  lastName: 'Chen',
  displayName: null,
  avatarUrl: null,
  deletedAt: null,
  membership: { status: 'active' },
};

describe('MemberQrService', () => {
  it('issues a token the verify side resolves to the member identity', async () => {
    const service = new MemberQrService(repoWith(MEMBER), KEY);

    const issued = await service.issue('mem_1');
    const result = await service.verify(issued.token);

    expect(issued.ttlSeconds).toBe(60);
    expect(result).toMatchObject({
      memberId: 'mem_1',
      memberNumber: 'A12345',
      displayName: 'Alice Chen',
      membershipStatus: 'active',
    });
  });

  it('refuses to issue for a deleted member', async () => {
    const service = new MemberQrService(repoWith({ ...MEMBER, deletedAt: new Date() }), KEY);
    await expect(service.issue('mem_1')).rejects.toThrow(MemberNotFoundError);
  });

  it("refuses a deleted member's still-fresh token at verification", async () => {
    const live = new MemberQrService(repoWith(MEMBER), KEY);
    const { token } = await live.issue('mem_1');

    const afterDeletion = new MemberQrService(repoWith({ ...MEMBER, deletedAt: new Date() }), KEY);
    await expect(afterDeletion.verify(token)).rejects.toThrow(QrTokenError);
  });

  it('refuses a token whose member no longer exists', async () => {
    const live = new MemberQrService(repoWith(MEMBER), KEY);
    const { token } = await live.issue('mem_1');

    const gone = new MemberQrService(repoWith(null), KEY);
    await expect(gone.verify(token)).rejects.toThrow(QrTokenError);
  });
});
