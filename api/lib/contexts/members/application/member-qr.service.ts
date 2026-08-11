import {
  MEMBER_QR_TOKEN_TTL_SECONDS,
  MemberNotFoundError,
  QrTokenError,
  memberDisplayName,
  signMemberQrToken,
  verifyMemberQrToken,
} from '../domain';
import type { MemberRepository } from '../infrastructure';

export interface QrVerificationResult {
  memberId: string;
  memberNumber: string;
  firstName: string;
  lastName: string;
  displayName: string;
  avatarUrl: string | null;
  membershipStatus: string | null;
  expiresAt: Date;
}

/**
 * Issues and verifies the member QR credential (short-lived HMAC token,
 * never the raw member id). Verification is the staff gate scan: it
 * re-reads the member row, so a deleted member's still-fresh token is
 * refused (any capability verified without a fresh principal read needs a
 * deletedAt check).
 */
export class MemberQrService {
  constructor(
    private readonly repo: MemberRepository,
    private readonly key: Buffer,
  ) {}

  async issue(memberId: string, now: Date = new Date()): Promise<{ token: string; expiresAt: Date; ttlSeconds: number }> {
    const member = await this.repo.getById(memberId);
    if (!member || member.deletedAt) throw new MemberNotFoundError(memberId);
    const { token, expiresAt } = signMemberQrToken(memberId, this.key, now);
    return { token, expiresAt, ttlSeconds: MEMBER_QR_TOKEN_TTL_SECONDS };
  }

  async verify(token: string, now: Date = new Date()): Promise<QrVerificationResult> {
    const claims = verifyMemberQrToken(token, this.key, now);
    const member = await this.repo.getById(claims.memberId);
    if (!member || member.deletedAt) throw new QrTokenError('tampered');

    return {
      memberId: member.id,
      memberNumber: member.memberNumber,
      firstName: member.firstName,
      lastName: member.lastName,
      displayName: memberDisplayName(member),
      avatarUrl: member.avatarUrl,
      membershipStatus: member.membership?.status ?? null,
      expiresAt: claims.expiresAt,
    };
  }
}
