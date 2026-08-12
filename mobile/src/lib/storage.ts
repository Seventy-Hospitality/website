/**
 * Secure persistence of the bearer session. The mobile client receives a
 * token PAIR (access + refresh) plus the access-token expiry in every auth
 * response body and in the magic-link deep-link callback; all three are kept
 * in expo-secure-store so a cold start can restore (and, if needed, silently
 * refresh) the session. Tokens are never logged.
 *
 * Stored under three keys rather than one JSON blob to stay well under
 * SecureStore's per-value size limit (JWT pairs can approach it).
 */
import * as SecureStore from 'expo-secure-store';

const ACCESS_TOKEN_KEY = 'seventy.session.accessToken';
const REFRESH_TOKEN_KEY = 'seventy.session.refreshToken';
const EXPIRES_AT_KEY = 'seventy.session.accessTokenExpiresAt';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** ISO instant the access token expires (for proactive refresh). */
  accessTokenExpiresAt: string;
}

export async function getStoredSession(): Promise<StoredSession | null> {
  const [accessToken, refreshToken, accessTokenExpiresAt] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.getItemAsync(EXPIRES_AT_KEY),
  ]);

  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: accessTokenExpiresAt ?? '',
  };
}

export async function setStoredSession(session: StoredSession): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_TOKEN_KEY, session.accessToken),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, session.refreshToken),
    SecureStore.setItemAsync(EXPIRES_AT_KEY, session.accessTokenExpiresAt),
  ]);
}

export async function clearStoredSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.deleteItemAsync(EXPIRES_AT_KEY),
  ]);
}
