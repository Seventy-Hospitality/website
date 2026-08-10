/**
 * Account-linking policy — pure decision logic for federated sign-in.
 *
 * Account linking is where takeovers live, so every rule is encoded here and
 * unit-tested hard. The services only execute the returned decision.
 *
 * Rules (in order):
 * 1. Resolve by (provider, subject) first, always. An existing identity wins
 *    over any email match, even when the provider email has since changed.
 * 2. Fall back to email matching only when the provider asserts the email is
 *    verified. An unverified provider email must never gain access to an
 *    existing account.
 * 3. Pre-hijack defense: linking a verified provider email to a local account
 *    whose email was never verified revokes the (possibly attacker-set)
 *    password credential and all existing sessions.
 */

export type Provider = 'google' | 'apple';

export interface ProviderAssertion {
  provider: Provider;
  subject: string;
  email: string | null; // normalized by the verifier
  emailVerified: boolean;
  isPrivateRelay: boolean;
  name: string | null;
}

export interface LinkContext {
  /** User owning an AuthIdentity row for (provider, subject), if any. */
  identityUser: { id: string; status: string } | null;
  /** User whose account email matches the asserted email, if any. */
  emailUser: { id: string; status: string; emailVerified: boolean } | null;
}

export type LinkRejectionReason =
  | 'account_unavailable'
  | 'email_required'
  | 'provider_email_unverified';

export type LinkDecision =
  | { action: 'sign_in'; userId: string }
  | { action: 'create_user'; emailVerified: boolean }
  | { action: 'link'; userId: string; revokePasswordCredential: boolean }
  | { action: 'reject'; reason: LinkRejectionReason };

export function decideLink(assertion: ProviderAssertion, ctx: LinkContext): LinkDecision {
  if (ctx.identityUser) {
    if (ctx.identityUser.status !== 'active') {
      return { action: 'reject', reason: 'account_unavailable' };
    }
    return { action: 'sign_in', userId: ctx.identityUser.id };
  }

  if (!assertion.email) {
    return { action: 'reject', reason: 'email_required' };
  }

  if (ctx.emailUser) {
    if (ctx.emailUser.status !== 'active') {
      return { action: 'reject', reason: 'account_unavailable' };
    }
    if (!assertion.emailVerified) {
      return { action: 'reject', reason: 'provider_email_unverified' };
    }
    return {
      action: 'link',
      userId: ctx.emailUser.id,
      revokePasswordCredential: !ctx.emailUser.emailVerified,
    };
  }

  return { action: 'create_user', emailVerified: assertion.emailVerified };
}

// ── Member claiming ──

/**
 * A signup/sign-in may claim an existing Member row (staff-created profiles,
 * possibly with an active membership and Stripe customer) only on a verified
 * email match, and only when the row is not already linked to a user.
 *
 * The verified-email requirement deliberately subsumes the narrower rule
 * "never auto-claim a member with an active membership from an unverified
 * email": no unverified email claims anything, membership or not.
 */
export interface MemberClaimContext {
  member: { id: string; userId: string | null } | null;
  /** Whether the claiming user's email is verified (locally or by provider). */
  emailVerified: boolean;
}

export type MemberClaimDecision = { action: 'claim'; memberId: string } | { action: 'none' };

export function decideMemberClaim(ctx: MemberClaimContext): MemberClaimDecision {
  if (!ctx.member) return { action: 'none' };
  if (ctx.member.userId !== null) return { action: 'none' };
  if (!ctx.emailVerified) return { action: 'none' };
  return { action: 'claim', memberId: ctx.member.id };
}
