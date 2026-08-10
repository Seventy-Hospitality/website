import { SignJWT, importPKCS8 } from 'jose';
import { IdentityConfigError } from '../domain';
import type { AppleAuthGateway } from '../application/ports';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_AUDIENCE = 'https://appleid.apple.com';

export interface AppleSecretConfig {
  teamId?: string;
  keyId?: string;
  privateKey?: string; // .p8 contents (PKCS8 PEM)
  bundleId?: string;
}

/**
 * Apple requires an ES256 client-secret JWT (max 6-month lifetime) for
 * /auth/token and /auth/revoke. A stored secret silently expires two quarters
 * after launch, so we mint one per call with a 5-minute expiry instead.
 */
export async function generateAppleClientSecret(config: Required<AppleSecretConfig>): Promise<string> {
  const key = await importPKCS8(config.privateKey, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.bundleId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .sign(key);
}

export class AppleTokenGateway implements AppleAuthGateway {
  constructor(private readonly config: AppleSecretConfig) {}

  isConfigured(): boolean {
    const { teamId, keyId, privateKey, bundleId } = this.config;
    return Boolean(teamId && keyId && privateKey && bundleId);
  }

  /** Exchanges a first-auth authorization code for the refresh token kept for /auth/revoke. */
  async exchangeCode(authorizationCode: string): Promise<{ refreshToken: string | null }> {
    if (!this.isConfigured()) {
      throw new IdentityConfigError('Apple client-secret signing (APPLE_TEAM_ID/KEY_ID/PRIVATE_KEY) is not configured');
    }

    const clientSecret = await generateAppleClientSecret(this.config as Required<AppleSecretConfig>);
    const response = await fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        client_id: this.config.bundleId!,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Apple token exchange failed with status ${response.status}`);
    }

    const body = (await response.json()) as { refresh_token?: string };
    return { refreshToken: body.refresh_token ?? null };
  }
}
