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
  | 'provider_email_unverified'
  | 'linked_to_other_account'
  | 'provider_already_linked'
  | 'account_email_unverified'
  | 'not_linked'
  | 'last_credential';

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

// ── Managing links from a signed-in account ──

/**
 * What the signed-in account can currently authenticate with. Linking and
 * unlinking are decided against this inventory, never against a single row.
 */
export interface CredentialInventory {
  linkedProviders: Provider[];
  hasPassword: boolean;
}

export type ManageLinkDecision =
  | { action: 'link' }
  /** The provider account is already this user's; re-linking is a no-op. */
  | { action: 'already_linked' }
  | { action: 'unlink' }
  | { action: 'reject'; reason: LinkRejectionReason };

/**
 * Linking a provider from settings. The caller is already authenticated, but
 * being signed in is not proof the caller owns the account: an attacker who
 * squats an unverified password account for victim@x can attach their own
 * provider identity to it before the victim ever signs in, surviving the
 * later pre-hijack password revoke (critique edge case 9). So linking requires
 * the account's own email to be verified first, and a (provider, subject) row
 * belonging to somebody else is never moved.
 */
export function decideLinkToAccount(params: {
  userId: string;
  accountEmailVerified: boolean;
  existingIdentityUserId: string | null;
  alreadyLinkedProvider: boolean;
}): ManageLinkDecision {
  if (params.existingIdentityUserId && params.existingIdentityUserId !== params.userId) {
    return { action: 'reject', reason: 'linked_to_other_account' };
  }
  if (params.existingIdentityUserId === params.userId) return { action: 'already_linked' };
  // An account whose email was never verified is not yet proven to belong to
  // the caller; attaching a credential to it would let a squatter pre-plant an
  // identity ahead of the real owner. Verify first.
  if (!params.accountEmailVerified) return { action: 'reject', reason: 'account_email_unverified' };
  // A second Google/Apple account for a provider this user already uses would
  // be ambiguous to unlink and to display; one identity per provider. This is
  // not "linked to another account" — the provider account is linked nowhere.
  if (params.alreadyLinkedProvider) return { action: 'reject', reason: 'provider_already_linked' };
  return { action: 'link' };
}

/**
 * Unlinking may never leave an account with no way back in (edge case 17):
 * the last remaining credential — provider identity or password — stays.
 */
export function decideUnlink(provider: Provider, inventory: CredentialInventory): ManageLinkDecision {
  if (!inventory.linkedProviders.includes(provider)) {
    return { action: 'reject', reason: 'not_linked' };
  }

  const remaining =
    inventory.linkedProviders.filter((p) => p !== provider).length + (inventory.hasPassword ? 1 : 0);
  if (remaining === 0) return { action: 'reject', reason: 'last_credential' };

  return { action: 'unlink' };
}

// ── Member claiming ──

/**
 * A signup/sign-in may claim an existing Member row (staff-created profiles,
 * possibly with an active membership and Stripe customer) only on a verified
 * email match, and only when the row is not already linked to a user.
 *
 * A row carrying billing (a Stripe customer or a membership) is a high-value
 * hijack target: an email-verification click proves the inbox received a
 * token, not that whoever now holds the account is its owner (the account may
 * have been created with an attacker's password). Such a row is handed over
 * only on a path that proves the authenticating party controls the account —
 * a magic link, provider OAuth, or a completed password reset (critique edge
 * case 22). A plain profile with no billing is low-harm and still auto-claims
 * on verification so ordinary signup works.
 */
export interface MemberClaimContext {
  member: { id: string; userId: string | null; hasBilling: boolean } | null;
  /** Whether the claiming user's email is verified (locally or by provider). */
  emailVerified: boolean;
  /**
   * Whether the auth path proves the person now holds the account (magic link,
   * provider OAuth, completed password reset), rather than merely that the
   * email inbox received a verification token.
   */
  accountControlProven: boolean;
}

export type MemberClaimDecision = { action: 'claim'; memberId: string } | { action: 'none' };

export function decideMemberClaim(ctx: MemberClaimContext): MemberClaimDecision {
  if (!ctx.member) return { action: 'none' };
  if (ctx.member.userId !== null) return { action: 'none' };
  if (!ctx.emailVerified) return { action: 'none' };
  if (ctx.member.hasBilling && !ctx.accountControlProven) return { action: 'none' };
  return { action: 'claim', memberId: ctx.member.id };
}
