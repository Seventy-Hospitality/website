/**
 * Native federated sign-in (Google + Apple), ported from the web client's
 * nonce contract to a React Native FederatedAuth port.
 *
 * Nonce contract (matches the backend account-linking service): fetch a
 * single-use RAW nonce from POST /api/auth/oauth/nonce, hand the platform SDK
 * `sha256(nonce)` as hex (so the ID token's `nonce` claim carries the hash),
 * and POST the ID token plus the RAW nonce to the verify endpoint. The
 * backend hashes the raw nonce, burns it, and compares against the claim.
 *
 * Degradation: each adapter reports `isConfigured()` from the env client IDs
 * (Apple is also available natively on iOS). When not configured the sign-in
 * buttons render disabled and `authenticate()` is never called, so no SDK is
 * initialized. The provider SDKs are imported lazily inside `authenticate()`.
 */
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import {
  APPLE_CLIENT_ID,
  GOOGLE_ANDROID_CLIENT_ID,
  GOOGLE_IOS_CLIENT_ID,
  GOOGLE_WEB_CLIENT_ID,
} from './env';

/** Lowercase-hex SHA-256, matching the backend's `hashToken` and web `sha256Hex`. */
export async function sha256Hex(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

export type OAuthProvider = 'google' | 'apple';

export class OAuthCancelledError extends Error {
  constructor() {
    super('The sign-in was cancelled');
    this.name = 'OAuthCancelledError';
  }
}

export class OAuthNotConfiguredError extends Error {
  constructor(provider: OAuthProvider) {
    super(`${provider} sign-in is not configured in this environment`);
    this.name = 'OAuthNotConfiguredError';
  }
}

/** What an adapter returns after the platform SDK issues an ID token. */
export interface ProviderAssertion {
  idToken: string;
  /** Apple only, and only on the user's first authorization. */
  fullName?: { givenName?: string; familyName?: string };
}

export interface FederatedAdapter {
  readonly provider: OAuthProvider;
  /** Client IDs (or native availability) are present for this provider. */
  isConfigured(): boolean;
  /** Runtime check that the provider can actually be presented on this device. */
  isAvailable(): Promise<boolean>;
  /** Drive the SDK with the hashed nonce and return the raw ID token. */
  authenticate(hashedNonce: string): Promise<ProviderAssertion>;
}

function googleClientId(): string | null {
  return (
    Platform.select({
      ios: GOOGLE_IOS_CLIENT_ID,
      android: GOOGLE_ANDROID_CLIENT_ID,
      default: GOOGLE_WEB_CLIENT_ID,
    }) ??
    GOOGLE_WEB_CLIENT_ID ??
    null
  );
}

// Google's OpenID endpoints (static; avoids a discovery round-trip).
const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
} as const;

export const googleAdapter: FederatedAdapter = {
  provider: 'google',
  isConfigured: () => Boolean(googleClientId()),
  isAvailable: async () => Boolean(googleClientId()),
  async authenticate(hashedNonce) {
    const clientId = googleClientId();
    if (!clientId) throw new OAuthNotConfiguredError('google');

    const AuthSession = await import('expo-auth-session');
    const redirectUri = AuthSession.makeRedirectUri({ scheme: 'seventy' });
    const request = new AuthSession.AuthRequest({
      clientId,
      redirectUri,
      responseType: AuthSession.ResponseType.IdToken,
      scopes: ['openid', 'profile', 'email'],
      usePKCE: false,
      // Google echoes this into the ID token's `nonce` claim verbatim.
      extraParams: { nonce: hashedNonce },
    });

    const result = await request.promptAsync(GOOGLE_DISCOVERY);
    if (result.type === 'cancel' || result.type === 'dismiss') throw new OAuthCancelledError();
    if (result.type !== 'success') {
      throw new Error(result.type === 'error' ? result.error?.message ?? 'Google sign-in failed' : 'Google sign-in failed');
    }
    const idToken = result.params.id_token;
    if (!idToken) throw new Error('Google did not return an ID token');
    return { idToken };
  },
};

export const appleAdapter: FederatedAdapter = {
  provider: 'apple',
  // Native Sign in with Apple needs no client ID on iOS (the bundle id is the
  // audience); Android/other rides the services ID via the web flow.
  isConfigured: () => Platform.OS === 'ios' || Boolean(APPLE_CLIENT_ID),
  async isAvailable() {
    if (Platform.OS !== 'ios') return Boolean(APPLE_CLIENT_ID);
    const AppleAuthentication = await import('expo-apple-authentication');
    return AppleAuthentication.isAvailableAsync();
  },
  async authenticate(hashedNonce) {
    if (Platform.OS !== 'ios') throw new OAuthNotConfiguredError('apple');

    const AppleAuthentication = await import('expo-apple-authentication');
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        // Apple echoes this into the ID token's `nonce` claim verbatim.
        nonce: hashedNonce,
      });
      if (!credential.identityToken) throw new Error('Apple did not return an identity token');
      const fullName = credential.fullName
        ? {
            givenName: credential.fullName.givenName ?? undefined,
            familyName: credential.fullName.familyName ?? undefined,
          }
        : undefined;
      return { idToken: credential.identityToken, fullName };
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ERR_REQUEST_CANCELED') {
        throw new OAuthCancelledError();
      }
      throw err;
    }
  },
};

export const federatedAdapters: Record<OAuthProvider, FederatedAdapter> = {
  google: googleAdapter,
  apple: appleAdapter,
};

/** The raw ID token + raw nonce ready to POST to the verify endpoint. */
export interface FederatedSignInResult {
  provider: OAuthProvider;
  idToken: string;
  rawNonce: string;
  fullName?: { givenName?: string; familyName?: string };
}

/**
 * Run the full nonce round-trip for an adapter: fetch a raw nonce, hand the
 * SDK its SHA-256 hash, and return the ID token with the RAW nonce for the
 * backend. `fetchNonce` is injected (api.oauthNonce) so this stays testable.
 */
export async function authenticateWithProvider(
  adapter: FederatedAdapter,
  fetchNonce: () => Promise<{ nonce: string }>,
): Promise<FederatedSignInResult> {
  if (!adapter.isConfigured()) throw new OAuthNotConfiguredError(adapter.provider);

  const { nonce: rawNonce } = await fetchNonce();
  const hashedNonce = await sha256Hex(rawNonce);
  const assertion = await adapter.authenticate(hashedNonce);

  return {
    provider: adapter.provider,
    idToken: assertion.idToken,
    rawNonce,
    fullName: assertion.fullName,
  };
}
