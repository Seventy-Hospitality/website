import {
  decideLink,
  decideLinkToAccount,
  decideMemberClaim,
  decideUnlink,
  type LinkContext,
  type ProviderAssertion,
} from './linking-policy';

function assertion(overrides: Partial<ProviderAssertion> = {}): ProviderAssertion {
  return {
    provider: 'google',
    subject: 'sub_123',
    email: 'person@example.com',
    emailVerified: true,
    isPrivateRelay: false,
    name: 'Person Example',
    ...overrides,
  };
}

const noMatch: LinkContext = { identityUser: null, emailUser: null };

describe('decideLink', () => {
  describe('(provider, subject) resolution comes first', () => {
    it('signs in when the identity already exists', () => {
      const decision = decideLink(assertion(), {
        identityUser: { id: 'usr_1', status: 'active' },
        emailUser: null,
      });
      expect(decision).toEqual({ action: 'sign_in', userId: 'usr_1' });
    });

    it('prefers the identity match over an email match on a different user', () => {
      // Provider email drifted to another user's address; the stable subject wins.
      const decision = decideLink(assertion({ email: 'other@example.com' }), {
        identityUser: { id: 'usr_1', status: 'active' },
        emailUser: { id: 'usr_2', status: 'active', emailVerified: true },
      });
      expect(decision).toEqual({ action: 'sign_in', userId: 'usr_1' });
    });

    it('signs in on identity match even when the provider email is unverified', () => {
      const decision = decideLink(assertion({ emailVerified: false }), {
        identityUser: { id: 'usr_1', status: 'active' },
        emailUser: null,
      });
      expect(decision).toEqual({ action: 'sign_in', userId: 'usr_1' });
    });

    it('signs in on identity match even without an email claim', () => {
      const decision = decideLink(assertion({ email: null, emailVerified: false }), {
        identityUser: { id: 'usr_1', status: 'active' },
        emailUser: null,
      });
      expect(decision).toEqual({ action: 'sign_in', userId: 'usr_1' });
    });

    it('rejects a suspended account on identity match', () => {
      const decision = decideLink(assertion(), {
        identityUser: { id: 'usr_1', status: 'suspended' },
        emailUser: null,
      });
      expect(decision).toEqual({ action: 'reject', reason: 'account_unavailable' });
    });

    it('rejects a deleted account on identity match', () => {
      const decision = decideLink(assertion(), {
        identityUser: { id: 'usr_1', status: 'deleted' },
        emailUser: null,
      });
      expect(decision).toEqual({ action: 'reject', reason: 'account_unavailable' });
    });
  });

  describe('no identity, no email claim', () => {
    it('rejects when the provider asserts no email at all', () => {
      const decision = decideLink(assertion({ email: null }), noMatch);
      expect(decision).toEqual({ action: 'reject', reason: 'email_required' });
    });
  });

  describe('email fallback onto an existing account', () => {
    it('links when both provider and local email are verified', () => {
      const decision = decideLink(assertion(), {
        identityUser: null,
        emailUser: { id: 'usr_2', status: 'active', emailVerified: true },
      });
      expect(decision).toEqual({
        action: 'link',
        userId: 'usr_2',
        revokePasswordCredential: false,
      });
    });

    it('never matches by email when the provider email is unverified', () => {
      const decision = decideLink(assertion({ emailVerified: false }), {
        identityUser: null,
        emailUser: { id: 'usr_2', status: 'active', emailVerified: true },
      });
      expect(decision).toEqual({ action: 'reject', reason: 'provider_email_unverified' });
    });

    it('pre-hijack defense: linking onto an unverified local account revokes the password credential', () => {
      // Attacker registered a password account for victim@gmail.com and never
      // verified it. The victim's Google sign-in takes the account; the
      // attacker's password must die with it.
      const decision = decideLink(assertion(), {
        identityUser: null,
        emailUser: { id: 'usr_2', status: 'active', emailVerified: false },
      });
      expect(decision).toEqual({
        action: 'link',
        userId: 'usr_2',
        revokePasswordCredential: true,
      });
    });

    it('rejects linking onto a suspended account', () => {
      const decision = decideLink(assertion(), {
        identityUser: null,
        emailUser: { id: 'usr_2', status: 'suspended', emailVerified: true },
      });
      expect(decision).toEqual({ action: 'reject', reason: 'account_unavailable' });
    });

    it('rejects linking onto a deleted account', () => {
      const decision = decideLink(assertion(), {
        identityUser: null,
        emailUser: { id: 'usr_2', status: 'deleted', emailVerified: true },
      });
      expect(decision).toEqual({ action: 'reject', reason: 'account_unavailable' });
    });
  });

  describe('new account creation', () => {
    it('creates a verified account for a verified provider email', () => {
      const decision = decideLink(assertion(), noMatch);
      expect(decision).toEqual({ action: 'create_user', emailVerified: true });
    });

    it('creates an unverified account for an unverified provider email', () => {
      const decision = decideLink(assertion({ emailVerified: false }), noMatch);
      expect(decision).toEqual({ action: 'create_user', emailVerified: false });
    });

    it('creates a verified account for an Apple private relay email', () => {
      // A relay address is still a working, provider-verified inbox. The
      // known limitation (edge 13: password account under the real email plus
      // a relay sign-in makes two accounts) is policy, handled via a manual
      // "link Apple" action later, not by guessing here.
      const decision = decideLink(
        assertion({
          provider: 'apple',
          email: 'abc123@privaterelay.appleid.com',
          isPrivateRelay: true,
        }),
        noMatch,
      );
      expect(decision).toEqual({ action: 'create_user', emailVerified: true });
    });
  });
});

describe('decideMemberClaim', () => {
  it('claims an unlinked no-billing member on a verified email match', () => {
    const decision = decideMemberClaim({
      member: { id: 'mem_1', userId: null, hasBilling: false },
      emailVerified: true,
      accountControlProven: false,
    });
    expect(decision).toEqual({ action: 'claim', memberId: 'mem_1' });
  });

  it('does nothing when no member row matches', () => {
    expect(
      decideMemberClaim({ member: null, emailVerified: true, accountControlProven: true }),
    ).toEqual({ action: 'none' });
  });

  it('never claims from an unverified email', () => {
    const decision = decideMemberClaim({
      member: { id: 'mem_1', userId: null, hasBilling: false },
      emailVerified: false,
      accountControlProven: true,
    });
    expect(decision).toEqual({ action: 'none' });
  });

  it('never claims a member already linked to another user', () => {
    const decision = decideMemberClaim({
      member: { id: 'mem_1', userId: 'usr_other', hasBilling: false },
      emailVerified: true,
      accountControlProven: true,
    });
    expect(decision).toEqual({ action: 'none' });
  });

  it('does not re-claim a member already linked to the same user', () => {
    // Idempotence: the caller passes the row as-is; a linked row is linked.
    const decision = decideMemberClaim({
      member: { id: 'mem_1', userId: 'usr_1', hasBilling: false },
      emailVerified: true,
      accountControlProven: true,
    });
    expect(decision).toEqual({ action: 'none' });
  });

  it('withholds a billing-carrying row when account control is not proven', () => {
    // A bare email-verification click must not hand over a paying member's
    // profile + Stripe billing to whoever set the account password.
    const decision = decideMemberClaim({
      member: { id: 'mem_1', userId: null, hasBilling: true },
      emailVerified: true,
      accountControlProven: false,
    });
    expect(decision).toEqual({ action: 'none' });
  });

  it('claims a billing-carrying row when account control is proven', () => {
    // Magic link / OAuth / completed reset prove the authenticating party holds
    // the account, so the high-value row may transfer.
    const decision = decideMemberClaim({
      member: { id: 'mem_1', userId: null, hasBilling: true },
      emailVerified: true,
      accountControlProven: true,
    });
    expect(decision).toEqual({ action: 'claim', memberId: 'mem_1' });
  });
});

describe('decideLinkToAccount', () => {
  const verified = { userId: 'usr_1', accountEmailVerified: true };

  it('links a provider account nobody owns yet', () => {
    expect(
      decideLinkToAccount({ ...verified, existingIdentityUserId: null, alreadyLinkedProvider: false }),
    ).toEqual({ action: 'link' });
  });

  it('is idempotent when the identity is already this account', () => {
    expect(
      decideLinkToAccount({ ...verified, existingIdentityUserId: 'usr_1', alreadyLinkedProvider: true }),
    ).toEqual({ action: 'already_linked' });
  });

  it('never steals a provider account from another user', () => {
    expect(
      decideLinkToAccount({ ...verified, existingIdentityUserId: 'usr_2', alreadyLinkedProvider: false }),
    ).toEqual({ action: 'reject', reason: 'linked_to_other_account' });
  });

  it('refuses linking to an account whose own email is unverified (pre-hijack)', () => {
    // An unverified account is not yet proven to belong to the caller: a
    // squatter must not pre-plant a provider identity ahead of the real owner.
    expect(
      decideLinkToAccount({
        userId: 'usr_1',
        accountEmailVerified: false,
        existingIdentityUserId: null,
        alreadyLinkedProvider: false,
      }),
    ).toEqual({ action: 'reject', reason: 'account_email_unverified' });
  });

  it('refuses a second account for a provider already linked here with its own reason', () => {
    expect(
      decideLinkToAccount({ ...verified, existingIdentityUserId: null, alreadyLinkedProvider: true }),
    ).toEqual({ action: 'reject', reason: 'provider_already_linked' });
  });
});

describe('decideUnlink', () => {
  it('unlinks when a password remains', () => {
    expect(decideUnlink('google', { linkedProviders: ['google'], hasPassword: true })).toEqual({
      action: 'unlink',
    });
  });

  it('unlinks when another provider remains', () => {
    expect(decideUnlink('google', { linkedProviders: ['google', 'apple'], hasPassword: false })).toEqual({
      action: 'unlink',
    });
  });

  it('refuses to remove the last remaining credential', () => {
    expect(decideUnlink('apple', { linkedProviders: ['apple'], hasPassword: false })).toEqual({
      action: 'reject',
      reason: 'last_credential',
    });
  });

  it('rejects a provider that is not linked', () => {
    expect(decideUnlink('apple', { linkedProviders: ['google'], hasPassword: true })).toEqual({
      action: 'reject',
      reason: 'not_linked',
    });
  });
});
