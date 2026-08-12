/**
 * Anti-forgery binding for the native magic-link deep-link flow.
 *
 * The `seventy://auth/callback` deep link is invocable by any app, web page, or
 * QR code, and the backend's /verify redirect hands the bearer token pair to
 * whatever `redirectTo` it was given. Without a binding, a crafted link could
 * inject an ATTACKER's token pair and silently sign the victim into the
 * attacker's account (login-CSRF / forced login).
 *
 * The binding is an app-generated `state` (like the OAuth `state` parameter):
 * before requesting a magic link we mint a random state, persist it as the
 * single pending request, and put it in `redirectTo`. The backend preserves
 * existing query params on the redirect (buildRedirectUrl only *sets* the
 * token params), so the state comes back on the callback, where we require it
 * to match the pending one and burn it (single-use). A callback whose state we
 * never issued is rejected before any session is established.
 */
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';

const PENDING_STATE_KEY = 'seventy.magicLink.pendingState';
const CALLBACK_PATH = '/auth/callback';

/** Constant-time-ish equality (fixed-length states; avoids early char leak). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Mint a random `state`, persist it as the single pending magic-link request
 * (superseding any earlier one), and return it. Call this immediately before
 * sending the magic link and thread the returned state into `redirectTo`.
 */
export async function createPendingMagicLinkState(): Promise<string> {
  const state = Crypto.randomUUID();
  await SecureStore.setItemAsync(PENDING_STATE_KEY, state);
  return state;
}

/** The deep-link `redirectTo` that carries the state back to the callback. */
export function buildMagicLinkRedirect(state: string): string {
  return Linking.createURL(CALLBACK_PATH, { queryParams: { state } });
}

/**
 * Validate the state echoed back on the callback against the single pending
 * request and consume it (single-use) regardless of outcome. Returns true ONLY
 * when a pending state existed and matches, i.e. this callback answers a magic
 * link THIS device actually requested. An injected/unsolicited callback (no
 * pending state, wrong state, or missing state) returns false.
 */
export async function consumePendingMagicLinkState(
  state: string | null | undefined,
): Promise<boolean> {
  const pending = await SecureStore.getItemAsync(PENDING_STATE_KEY);
  // Burn it whatever happens: a link is single-use, and a failed attempt must
  // not leave the pending state around for a later injected callback to match.
  await SecureStore.deleteItemAsync(PENDING_STATE_KEY);
  if (!pending || !state) return false;
  return safeEqual(pending, state);
}
