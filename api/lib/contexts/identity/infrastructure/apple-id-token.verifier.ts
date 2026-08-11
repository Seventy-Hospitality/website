import { createRemoteJWKSet, jwtVerify } from 'jose';
import { IdentityConfigError, InvalidTokenError, type ProviderAssertion } from '../domain';
import type { FederatedIdTokenVerifier } from '../application/ports';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const PRIVATE_RELAY_DOMAIN = '@privaterelay.appleid.com';

/** Apple booleans arrive as true or the string "true" depending on the flow. */
function appleBool(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Verifies an Apple identity token from Sign in with Apple — on device (aud
 * is the native bundle ID) or via Sign in with Apple JS on the web (aud is
 * the web services ID). `audiences` is the explicit aud allowlist built from
 * whichever of the two is configured.
 * Note: fullName never appears in the token; the client sends it separately
 * on first authorization and the linking service persists it then.
 */
export class AppleIdTokenVerifier implements FederatedIdTokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly audiences: string[]) {}

  async verify(idToken: string, expectedNonceHash: string): Promise<ProviderAssertion> {
    if (this.audiences.length === 0) {
      throw new IdentityConfigError(
        'Apple Sign in is not configured (set APPLE_BUNDLE_ID and/or APPLE_WEB_SERVICES_ID)',
      );
    }

    this.jwks ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL));

    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: this.audiences,
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
      provider: 'apple',
      subject: payload.sub,
      email,
      // Apple emails are deliverable (real or relay); treat absence of the
      // claim as unverified rather than trusting a default.
      emailVerified: appleBool(payload.email_verified),
      isPrivateRelay:
        appleBool(payload.is_private_email) || (email?.endsWith(PRIVATE_RELAY_DOMAIN) ?? false),
      name: null,
    };
  }
}
