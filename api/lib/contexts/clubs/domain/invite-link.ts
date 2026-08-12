// Invite-link validity (pure). Tokens themselves are minted/hashed with the
// identity domain's generateToken/hashToken (sha256 at rest, raw value
// leaves the API exactly once); this module only judges a stored link.

export interface ClubInviteLinkState {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
}

export type InviteLinkVerdict = 'valid' | 'revoked' | 'expired' | 'exhausted';

/** Default lifetime of a share link/QR; rotation mints a fresh window. */
export const DEFAULT_INVITE_LINK_TTL_DAYS = 30;
export const MAX_INVITE_LINK_TTL_DAYS = 365;
export const MAX_INVITE_LINK_USES = 500;

/**
 * Precedence: revocation beats expiry beats exhaustion (a revoked link stays
 * revoked whatever else is true). Expiry is inclusive: a link is dead AT its
 * expiresAt instant.
 */
export function evaluateInviteLink(link: ClubInviteLinkState, now: Date): InviteLinkVerdict {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (link.maxUses != null && link.useCount >= link.maxUses) return 'exhausted';
  return 'valid';
}

export function inviteLinkExpiry(now: Date, days = DEFAULT_INVITE_LINK_TTL_DAYS): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
