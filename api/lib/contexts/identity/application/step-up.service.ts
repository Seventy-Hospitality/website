import type { NotificationService } from '@/lib/contexts/communications/application';
import {
  InvalidTokenError,
  generateToken,
  hashToken,
  tokenExpiry,
  type Principal,
  type Provider,
} from '../domain';
import type { AuthIdentityRepository } from '../infrastructure/auth-identity.repository';
import type { AuthTokenRepository } from '../infrastructure/auth-token.repository';
import type { CredentialRepository } from '../infrastructure/credential.repository';
import type { FederatedIdTokenVerifier, PasswordHasher } from './ports';

export type StepUpMethod = 'password' | 'oauth' | 'reauth_email';

export type StepUpProof =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; provider: Provider; idToken: string; nonce: string }
  | { kind: 'reauth_email'; token: string };

export class StepUpRequiredError extends Error {
  constructor(public readonly acceptableMethods: StepUpMethod[]) {
    super('Recent re-authentication is required for this action');
    this.name = 'StepUpRequiredError';
  }
}

export class StepUpFailedError extends Error {
  constructor() {
    super('Re-authentication failed');
    this.name = 'StepUpFailedError';
  }
}

/**
 * Step-up re-authentication for destructive actions (account deletion).
 * Verifies exactly one proof against the CURRENT principal:
 *
 * - password: the account's current password.
 * - oauth: a FRESH provider assertion (server-issued nonce burned on use),
 *   and the asserted (provider, subject) must already be linked to THIS
 *   user; a valid token for some other Google account proves nothing.
 * - reauth_email: a single-use emailed token minted by the authenticated
 *   user, bound to their userId AND session (bindingHash), its own
 *   purpose so a sign-in magic link can never double as deletion proof.
 */
export class StepUpService {
  /** Lazily-built hash so wrong-account guesses cost a real verify. */
  private timingEqualizer: Promise<string> | null = null;

  constructor(
    private readonly credentials: CredentialRepository,
    private readonly identities: AuthIdentityRepository,
    private readonly tokens: AuthTokenRepository,
    private readonly hasher: PasswordHasher,
    private readonly verifiers: Record<Provider, FederatedIdTokenVerifier>,
    private readonly notifications: NotificationService,
  ) {}

  /** What this account can prove with (for the 403's method list). */
  async acceptableMethods(userId: string): Promise<StepUpMethod[]> {
    const methods: StepUpMethod[] = [];
    if (await this.credentials.hasPassword(userId)) methods.push('password');
    if ((await this.identities.listByUser(userId)).length > 0) methods.push('oauth');
    methods.push('reauth_email');
    return methods;
  }

  /** Emails a fresh re-auth token to the signed-in account. */
  async sendReauthEmail(principal: Principal): Promise<void> {
    const { token, hash } = generateToken();
    await this.tokens.invalidateAll('reauth', principal.userId);
    await this.tokens.create({
      purpose: 'reauth',
      identifier: principal.userId,
      tokenHash: hash,
      bindingHash: hashToken(principal.sessionId),
      expiresAt: tokenExpiry('reauth'),
    });
    await this.notifications.sendAccountReauth(principal.email, token);
  }

  /** Verifies one proof; throws StepUpFailedError on any mismatch. */
  async verify(principal: Principal, proof: StepUpProof): Promise<StepUpMethod> {
    switch (proof.kind) {
      case 'password': {
        const credential = await this.credentials.findPassword(principal.userId);
        if (!credential) {
          // Equalize timing so "has no password" is not observable.
          this.timingEqualizer ??= this.hasher.hash('timing-equalizer');
          await this.hasher.verify(await this.timingEqualizer, proof.password);
          throw new StepUpFailedError();
        }
        if (!(await this.hasher.verify(credential.secretHash, proof.password))) {
          throw new StepUpFailedError();
        }
        return 'password';
      }

      case 'oauth': {
        const nonceHash = hashToken(proof.nonce);
        const consumed = await this.tokens.consume('oauth_nonce', nonceHash);
        if (!consumed) throw new StepUpFailedError();

        let subject: string;
        try {
          ({ subject } = await this.verifiers[proof.provider].verify(proof.idToken, nonceHash));
        } catch {
          throw new StepUpFailedError();
        }
        // MANDATORY subject binding: the asserted provider account must be
        // one of THIS user's linked identities.
        const identity = await this.identities.findByProviderSubject(proof.provider, subject);
        if (!identity || identity.userId !== principal.userId) throw new StepUpFailedError();
        return 'oauth';
      }

      case 'reauth_email': {
        const consumed = await this.tokens.consume('reauth', hashToken(proof.token));
        if (!consumed) throw new StepUpFailedError();
        // Subject- AND session-bound: a token minted on a hijacker's own
        // account (or another device) proves nothing here.
        if (consumed.identifier !== principal.userId) throw new StepUpFailedError();
        if (consumed.bindingHash !== hashToken(principal.sessionId)) throw new StepUpFailedError();
        return 'reauth_email';
      }

      default: {
        const unhandled: never = proof;
        throw new Error(`Unhandled step-up proof: ${String(unhandled)}`);
      }
    }
  }
}
