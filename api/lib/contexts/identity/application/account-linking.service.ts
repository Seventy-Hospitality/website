import type { UnitOfWork } from '@/lib/kernel/unit-of-work';
import {
  decideLink,
  decideLinkToAccount,
  decideUnlink,
  generateToken,
  hashToken,
  tokenExpiry,
  InvalidTokenError,
  LinkRejectedError,
  type Client,
  type Provider,
  type ProviderAssertion,
} from '../domain';
import type { UserRepository, IdentityUser } from '../infrastructure/user.repository';
import type { CredentialRepository } from '../infrastructure/credential.repository';
import type { AuthIdentityRepository } from '../infrastructure/auth-identity.repository';
import type { AuthTokenRepository } from '../infrastructure/auth-token.repository';
import type {
  AppleAuthGateway,
  AuditLog,
  FederatedIdTokenVerifier,
  SecretCipher,
} from './ports';
import type { SessionService, IssuedSession, SessionMeta } from './session.service';
import { MemberClaimService, splitFullName } from './member-claiming';

export interface GoogleSignInInput {
  idToken: string;
  nonce: string;
}

export interface AppleSignInInput {
  identityToken: string;
  nonce: string;
  /** First-auth only; exchanged for the refresh token kept for /auth/revoke. */
  authorizationCode?: string;
  /** Apple surfaces the name once, on first authorization, never in the token. */
  fullName?: { givenName?: string; familyName?: string };
}

/** Linking a provider to the account already signed in (settings screen). */
export interface LinkProviderInput {
  idToken: string;
  nonce: string;
  authorizationCode?: string;
}

export interface LinkedCredentials {
  identities: Array<{
    provider: Provider;
    email: string | null;
    isPrivateRelay: boolean;
    linkedAt: Date;
    lastUsedAt: Date | null;
  }>;
  hasPassword: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return err != null && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002';
}

/**
 * Federated sign-in: nonce burning, ID-token verification, then executing
 * whatever the pure linking policy decided.
 */
export class AccountLinkingService {
  constructor(
    private readonly users: UserRepository,
    private readonly identities: AuthIdentityRepository,
    private readonly credentials: CredentialRepository,
    private readonly tokens: AuthTokenRepository,
    private readonly verifiers: { google: FederatedIdTokenVerifier; apple: FederatedIdTokenVerifier },
    private readonly appleGateway: AppleAuthGateway,
    private readonly cipher: SecretCipher,
    private readonly memberClaims: MemberClaimService,
    private readonly sessions: SessionService,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * Single-use nonce for native OAuth. The client passes sha256(nonce) to the
   * platform SDK (so the ID token carries the hash) and returns the raw nonce
   * with the token; the server burns the row and checks the claim.
   */
  async issueNonce(): Promise<{ nonce: string; expiresAt: Date }> {
    const { token, hash } = generateToken();
    const expiresAt = tokenExpiry('oauth_nonce');
    await this.tokens.create({ purpose: 'oauth_nonce', identifier: 'oauth', tokenHash: hash, expiresAt });
    return { nonce: token, expiresAt };
  }

  async signInWithGoogle(input: GoogleSignInInput, client: Client, meta?: SessionMeta): Promise<IssuedSession> {
    const assertion = await this.verifyWithNonce(this.verifiers.google, input.idToken, input.nonce);
    const { user } = await this.resolveWithRetry(assertion, {});
    return this.sessions.issue(user, client, meta);
  }

  async signInWithApple(input: AppleSignInInput, client: Client, meta?: SessionMeta): Promise<IssuedSession> {
    const assertion = await this.verifyWithNonce(this.verifiers.apple, input.identityToken, input.nonce);
    const fallbackName = [input.fullName?.givenName, input.fullName?.familyName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const { user, identityId } = await this.resolveWithRetry(assertion, {
      fallbackName: fallbackName || undefined,
    });

    if (input.authorizationCode && this.appleGateway.isConfigured()) {
      await this.storeAppleRefreshToken(identityId, input.authorizationCode);
    }

    return this.sessions.issue(user, client, meta);
  }

  // ── Managing links from a signed-in account ──

  /** What the account can sign in with today. */
  async listCredentials(userId: string): Promise<LinkedCredentials> {
    const [identities, hasPassword] = await Promise.all([
      this.identities.listByUser(userId),
      this.credentials.hasPassword(userId),
    ]);

    return {
      identities: identities.map((identity) => ({
        provider: identity.provider as Provider,
        email: identity.email,
        isPrivateRelay: identity.isPrivateRelay,
        linkedAt: identity.linkedAt,
        lastUsedAt: identity.lastUsedAt,
      })),
      hasPassword,
    };
  }

  /**
   * Link a provider to the signed-in account. Same verifier + nonce flow as
   * sign-in; the account comes from the principal, so no email matching is
   * involved and a provider account owned by somebody else is refused rather
   * than moved.
   */
  async linkProvider(
    userId: string,
    provider: Provider,
    input: LinkProviderInput,
  ): Promise<{ linked: boolean }> {
    const assertion = await this.verifyWithNonce(this.verifiers[provider], input.idToken, input.nonce);

    const existing = await this.identities.findByProviderSubject(provider, assertion.subject);
    const linked = await this.identities.listByUser(userId);
    const decision = decideLinkToAccount({
      userId,
      existingIdentityUserId: existing?.userId ?? null,
      alreadyLinkedProvider: linked.some((identity) => identity.provider === provider),
    });

    if (decision.action === 'reject') throw new LinkRejectedError(decision.reason);
    if (decision.action === 'already_linked') return { linked: false };

    const identityId = await this.uow.execute(async (tx) => {
      const created = await this.identities.create(
        {
          userId,
          provider,
          subject: assertion.subject,
          email: assertion.email,
          emailVerified: assertion.emailVerified,
          isPrivateRelay: assertion.isPrivateRelay,
        },
        tx,
      );
      await this.audit.append(tx, {
        streamType: 'user',
        streamId: userId,
        eventType: 'IdentityLinked',
        data: { provider, subject: assertion.subject, source: 'account_settings' },
        actorId: userId,
      });
      return created.id;
    });

    if (provider === 'apple' && input.authorizationCode && this.appleGateway.isConfigured()) {
      await this.storeAppleRefreshToken(identityId, input.authorizationCode);
    }

    return { linked: true };
  }

  /** Unlink a provider, never leaving the account without a credential. */
  async unlinkProvider(userId: string, provider: Provider): Promise<void> {
    const { identities, hasPassword } = await this.listCredentials(userId);
    const decision = decideUnlink(provider, {
      linkedProviders: identities.map((identity) => identity.provider),
      hasPassword,
    });
    if (decision.action === 'reject') throw new LinkRejectedError(decision.reason);

    await this.uow.execute(async (tx) => {
      await this.identities.deleteForUser(userId, provider, tx);
      await this.audit.append(tx, {
        streamType: 'user',
        streamId: userId,
        eventType: 'IdentityUnlinked',
        data: { provider },
        actorId: userId,
      });
    });
  }

  private async verifyWithNonce(
    verifier: FederatedIdTokenVerifier,
    idToken: string,
    nonce: string,
  ): Promise<ProviderAssertion> {
    const nonceHash = hashToken(nonce);
    const consumed = await this.tokens.consume('oauth_nonce', nonceHash);
    if (!consumed) throw new InvalidTokenError();
    return verifier.verify(idToken, nonceHash);
  }

  private async resolveWithRetry(
    assertion: ProviderAssertion,
    extras: { fallbackName?: string },
  ): Promise<{ user: IdentityUser; identityId: string }> {
    try {
      return await this.resolve(assertion, extras);
    } catch (err) {
      // Concurrent first-time sign-ins race on @@unique([provider, subject]);
      // by the retry the identity exists and resolves to sign_in.
      if (isUniqueViolation(err)) return this.resolve(assertion, extras);
      throw err;
    }
  }

  private async resolve(
    assertion: ProviderAssertion,
    extras: { fallbackName?: string },
  ): Promise<{ user: IdentityUser; identityId: string }> {
    const identity = await this.identities.findByProviderSubject(assertion.provider, assertion.subject);
    const identityUser = identity ? await this.users.findById(identity.userId) : null;
    const emailUser = assertion.email ? await this.users.findByEmail(assertion.email) : null;

    const decision = decideLink(assertion, {
      identityUser: identityUser ? { id: identityUser.id, status: identityUser.status } : null,
      emailUser: emailUser
        ? { id: emailUser.id, status: emailUser.status, emailVerified: emailUser.emailVerifiedAt !== null }
        : null,
    });

    switch (decision.action) {
      case 'reject':
        throw new LinkRejectedError(decision.reason);

      case 'sign_in':
        return this.uow.execute(async (tx) => {
          await this.identities.touchUsed(
            identity!.id,
            {
              email: assertion.email,
              emailVerified: assertion.emailVerified,
              isPrivateRelay: assertion.isPrivateRelay,
            },
            tx,
          );
          // A staff-created member row may have appeared since last sign-in.
          if (identityUser!.emailVerifiedAt) {
            await this.memberClaims.claimIfEligible(tx, identityUser!);
          }
          return { user: identityUser!, identityId: identity!.id };
        });

      case 'create_user': {
        const name = (assertion.name ?? extras.fallbackName ?? assertion.email!.split('@')[0]).trim();
        return this.uow.execute(async (tx) => {
          const user = await this.users.createUser(
            {
              email: assertion.email!,
              name,
              emailVerifiedAt: decision.emailVerified ? new Date() : null,
            },
            tx,
          );
          const identityRow = await this.identities.create(
            {
              userId: user.id,
              provider: assertion.provider,
              subject: assertion.subject,
              email: assertion.email,
              emailVerified: assertion.emailVerified,
              isPrivateRelay: assertion.isPrivateRelay,
            },
            tx,
          );
          await this.audit.append(tx, {
            streamType: 'user',
            streamId: user.id,
            eventType: 'UserSignedUp',
            data: { email: user.email, method: assertion.provider },
            actorId: user.id,
          });
          const { claimedMemberId } = await this.memberClaims.claimIfEligible(tx, user);
          if (!claimedMemberId) {
            await this.memberClaims.createProfileIfAbsent(tx, user, splitFullName(name));
          }
          return { user, identityId: identityRow.id };
        });
      }

      case 'link':
        return this.uow.execute(async (tx) => {
          const identityRow = await this.identities.create(
            {
              userId: decision.userId,
              provider: assertion.provider,
              subject: assertion.subject,
              email: assertion.email,
              emailVerified: assertion.emailVerified,
              isPrivateRelay: assertion.isPrivateRelay,
            },
            tx,
          );

          let user = emailUser!;
          if (decision.revokePasswordCredential) {
            // Pre-hijack defense: the unverified password credential (and any
            // sessions it minted) may belong to an attacker. Kill both.
            await this.credentials.deletePassword(user.id, tx);
            await this.tokens.invalidateAll('password_reset', user.id, tx);
            await this.sessions.revokeAllForUser(user.id, 'identity_link_password_revoked', { tx });
          }

          if (!user.emailVerifiedAt) {
            // Link decisions only happen on provider-verified emails.
            const now = new Date();
            await this.users.markEmailVerified(user.id, now, tx);
            user = { ...user, emailVerifiedAt: now };
            await this.audit.append(tx, {
              streamType: 'user',
              streamId: user.id,
              eventType: 'EmailVerified',
              data: { email: user.email, method: assertion.provider },
              actorId: user.id,
            });
          }

          await this.audit.append(tx, {
            streamType: 'user',
            streamId: user.id,
            eventType: 'IdentityLinked',
            data: {
              provider: assertion.provider,
              subject: assertion.subject,
              revokedPasswordCredential: decision.revokePasswordCredential,
            },
            actorId: user.id,
          });

          await this.memberClaims.claimIfEligible(tx, user);
          return { user, identityId: identityRow.id };
        });
    }
  }

  /** Best-effort: a failed exchange must not fail the sign-in. */
  private async storeAppleRefreshToken(identityId: string, authorizationCode: string): Promise<void> {
    try {
      const { refreshToken } = await this.appleGateway.exchangeCode(authorizationCode);
      if (refreshToken) {
        await this.identities.setRefreshToken(identityId, this.cipher.encrypt(refreshToken));
      }
    } catch (err) {
      console.warn('[identity] Apple authorization-code exchange failed:', err);
    }
  }
}
