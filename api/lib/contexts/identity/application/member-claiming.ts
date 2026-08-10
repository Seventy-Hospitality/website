import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import { decideMemberClaim } from '../domain';
import type { AuditLog, MemberDirectory } from './ports';

export interface ClaimingUser {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
}

/** "Mary Jane Watson" -> { firstName: "Mary Jane", lastName: "Watson" }. */
export function splitFullName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/**
 * Links users to their Member rows. Claiming an existing row (staff-created,
 * possibly carrying an active membership and Stripe customer) is gated by the
 * pure claim policy: verified email match only, audited in-transaction.
 */
export class MemberClaimService {
  constructor(
    private readonly members: MemberDirectory,
    private readonly audit: AuditLog,
  ) {}

  async claimIfEligible(
    tx: TransactionContext,
    user: ClaimingUser,
  ): Promise<{ claimedMemberId: string | null }> {
    const member = await this.members.findByEmail(tx, user.email);
    const decision = decideMemberClaim({ member, emailVerified: user.emailVerifiedAt !== null });
    if (decision.action !== 'claim') return { claimedMemberId: null };

    await this.members.claim(tx, decision.memberId, user.id);
    await this.audit.append(tx, {
      streamType: 'member',
      streamId: decision.memberId,
      eventType: 'MemberClaimed',
      data: { userId: user.id, email: user.email },
      actorId: user.id,
    });
    return { claimedMemberId: decision.memberId };
  }

  /**
   * Creates a fresh member profile at signup. When a row already matches the
   * email it is a claim candidate instead, resolved once the email is
   * verified, so nothing is created here.
   */
  async createProfileIfAbsent(
    tx: TransactionContext,
    user: { id: string; email: string },
    profile: { firstName: string; lastName: string; phone?: string },
  ): Promise<{ createdMemberId: string | null }> {
    const existing = await this.members.findByEmail(tx, user.email);
    if (existing) return { createdMemberId: null };
    const member = await this.members.createForUser(tx, { userId: user.id, email: user.email, ...profile });
    return { createdMemberId: member.id };
  }
}
