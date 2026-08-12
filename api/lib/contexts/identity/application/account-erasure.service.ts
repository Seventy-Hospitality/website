import type { UnitOfWork } from '@/lib/kernel/unit-of-work';
import { IdentityConfigError } from '../domain';
import type { AuthIdentityRepository } from '../infrastructure/auth-identity.repository';
import type { AuthTokenRepository } from '../infrastructure/auth-token.repository';
import type { CredentialRepository } from '../infrastructure/credential.repository';
import type { UserRepository } from '../infrastructure/user.repository';
import type { AppleAuthGateway, AuditLog, SecretCipher } from './ports';
import type { SessionService } from './session.service';

export type AppleRevokeOutcome = 'revoked' | 'not_applicable' | 'undecryptable';

/**
 * The identity side of account deletion, called by the account context's
 * pipeline through narrow steps so each external effect can be retried
 * independently:
 *
 * 1. quiesce: freeze-stamp the user + revoke every OTHER session (the
 *    session driving the deletion keeps working for retries).
 * 2. revokeAppleTokens: /auth/revoke every stored refresh token BEFORE the
 *    identity rows are deleted (deleting first would destroy the only copy
 *    and make revocation permanently impossible).
 * 3. eraseCredentials: delete credentials + provider identities, burn every
 *    outstanding one-time token (magic links by the PRE-tombstone email),
 *    revoke every remaining session.
 * 4. tombstoneUser: status='deleted', deletedAt, tombstoned email.
 */
export class AccountErasureService {
  constructor(
    private readonly users: UserRepository,
    private readonly credentials: CredentialRepository,
    private readonly identities: AuthIdentityRepository,
    private readonly tokens: AuthTokenRepository,
    private readonly sessions: SessionService,
    private readonly appleGateway: AppleAuthGateway,
    private readonly cipher: SecretCipher,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  /** Step 0: freeze the account and kill every other device's session. */
  async quiesce(userId: string, exceptSessionId: string | undefined, when: Date = new Date()): Promise<void> {
    await this.uow.execute(async (tx) => {
      await this.users.markDeletionRequested(userId, when, tx);
      await this.sessions.revokeAllForUser(
        userId,
        'account_deletion',
        exceptSessionId ? { exceptSessionId, tx } : { tx },
      );
      await this.audit.append(tx, {
        streamType: 'user',
        streamId: userId,
        eventType: 'AccountDeletionRequested',
        data: {},
        actorId: userId,
      });
    });
  }

  /**
   * Revokes every stored Apple refresh token. Throws on transient network
   * failure and on an unconfigured gateway WITH a stored token (the
   * pipeline retries; capping is the request's concern) so the identity
   * row survives for the retry. An undecryptable token (secret rotated) is
   * terminal for revocation and reported, not thrown.
   */
  async revokeAppleTokens(userId: string): Promise<AppleRevokeOutcome> {
    const appleIdentities = (await this.identities.listByUser(userId)).filter(
      (identity) => identity.provider === 'apple' && identity.refreshTokenEnc,
    );
    if (appleIdentities.length === 0) return 'not_applicable';

    if (!this.appleGateway.isConfigured()) {
      throw new IdentityConfigError(
        'A stored Apple refresh token cannot be revoked: the Apple gateway is not configured',
      );
    }

    let undecryptable = false;
    for (const identity of appleIdentities) {
      let refreshToken: string;
      try {
        refreshToken = this.cipher.decrypt(identity.refreshTokenEnc!);
      } catch {
        // Key rotation broke the ciphertext; revocation is permanently
        // impossible for this token. Record, do not block the deletion.
        undecryptable = true;
        continue;
      }
      await this.appleGateway.revoke(refreshToken);
    }
    return undecryptable ? 'undecryptable' : 'revoked';
  }

  /** Deletes every way of signing in. Idempotent. */
  async eraseCredentials(userId: string, preTombstoneEmail: string): Promise<void> {
    await this.uow.execute(async (tx) => {
      await this.credentials.deletePassword(userId, tx);
      await this.identities.deleteAllForUser(userId, tx);
      // Outstanding one-time tokens: magic links key on the email (burn
      // them BEFORE the tombstone rewrites it), the rest on the userId.
      await this.tokens.invalidateAll('magic_link', preTombstoneEmail.trim().toLowerCase(), tx);
      await this.tokens.invalidateAll('password_reset', userId, tx);
      await this.tokens.invalidateAll('email_verification', userId, tx);
      await this.tokens.invalidateAll('reauth', userId, tx);
      await this.sessions.revokeAllForUser(userId, 'account_deletion', { tx });
      await this.audit.append(tx, {
        streamType: 'user',
        streamId: userId,
        eventType: 'CredentialsErased',
        data: {},
        actorId: userId,
      });
    });
  }

  /** Soft-delete + email tombstone. Idempotent. */
  async tombstoneUser(userId: string, when: Date = new Date()): Promise<void> {
    await this.uow.execute(async (tx) => {
      await this.users.tombstoneForDeletion(userId, when, tx);
    });
  }
}
