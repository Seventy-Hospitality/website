import type { TransactionContext } from '@/lib/kernel/unit-of-work';
import type { ProviderAssertion } from '../domain';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(phcHash: string, password: string): Promise<boolean>;
  /** True when the stored hash predates the current parameters (rehash on login). */
  needsRehash(phcHash: string): boolean;
}

/**
 * Server-side verification of a native-app ID token (Google/Apple).
 * The swap seam if auth is ever bought.
 */
export interface FederatedIdTokenVerifier {
  /**
   * Verifies signature, issuer, audience, expiry and the nonce claim
   * (`expectedNonceHash` = sha256 hex of the server-issued nonce, which is
   * what the platform SDKs embed).
   */
  verify(idToken: string, expectedNonceHash: string): Promise<ProviderAssertion>;
}

/** Apple authorization-code exchange; yields the refresh token kept for /auth/revoke. */
export interface AppleAuthGateway {
  isConfigured(): boolean;
  exchangeCode(authorizationCode: string): Promise<{ refreshToken: string | null }>;
  /**
   * Revokes the stored refresh token (required before account deletion for
   * apps offering Sign in with Apple). An already-revoked token
   * (invalid_grant) counts as success; transient failures throw.
   */
  revoke(refreshToken: string): Promise<void>;
}

/** Reversible encryption for provider refresh tokens at rest. */
export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/** Same-transaction audit trail (satisfied by the shared EventStore). */
export interface AuditLog {
  append(
    tx: TransactionContext,
    event: {
      streamType: string;
      streamId: string;
      eventType: string;
      data: unknown;
      actorId?: string;
    },
  ): Promise<unknown>;
}

/**
 * Stage-1 seam into the members BC for signup-time profile creation and
 * verified-email claiming. Later packages fold this into the members context
 * proper; keeping it a port here means only the adapter touches their table.
 */
export interface MemberDirectory {
  findByEmail(
    tx: TransactionContext,
    email: string,
  ): Promise<{ id: string; userId: string | null; hasBilling: boolean } | null>;
  /**
   * Guarded claim of an unlinked row. Returns false (never throws) when the
   * row was claimed concurrently, so a benign race is a no-op, not a 500.
   */
  claim(tx: TransactionContext, memberId: string, userId: string): Promise<boolean>;
  createForUser(
    tx: TransactionContext,
    input: { userId: string; email: string; firstName: string; lastName: string; phone?: string },
  ): Promise<{ id: string }>;
}
