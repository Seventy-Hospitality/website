import { createRemoteJWKSet, jwtVerify } from 'jose';
import { IdentityConfigError, InvalidTokenError, type ProviderAssertion } from '../domain';
import type { FederatedIdTokenVerifier } from '../application/ports';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Verifies a Google ID token obtained by the native SDK on device.
 * `clientIds` is the explicit aud allowlist (iOS/Android/web client IDs).
 */
export class GoogleIdTokenVerifier implements FederatedIdTokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly clientIds: string[]) {}

  async verify(idToken: string, expectedNonceHash: string): Promise<ProviderAssertion> {
    if (this.clientIds.length === 0) {
      throw new IdentityConfigError('GOOGLE_OAUTH_CLIENT_IDS is not configured');
    }

    this.jwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: GOOGLE_ISSUERS,
        audience: this.clientIds,
        clockTolerance: 5,
      }));
    } catch {
      throw new InvalidTokenError();
    }

    if (typeof payload.sub !== 'string' || payload.nonce !== expectedNonceHash) {
      throw new InvalidTokenError();
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;

    return {
      provider: 'google',
      subject: payload.sub,
      email,
      emailVerified: payload.email_verified === true,
      isPrivateRelay: false,
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  }
}
