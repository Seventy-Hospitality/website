/**
 * Google Identity Services + Sign in with Apple JS plumbing.
 *
 * Nonce contract (matches the backend's account-linking service): the client
 * asks POST /api/auth/oauth/nonce for a single-use raw nonce, hands the
 * provider SDK sha256(nonce) as hex (so the ID token carries the hash), and
 * POSTs the RAW nonce with the ID token to the verify endpoint. The backend
 * hashes the raw nonce, burns it, and compares against the token claim.
 *
 * Both SDKs load lazily from their official origins only when a client ID is
 * configured; with no client ID the buttons render a "not configured" state
 * and nothing is loaded (see components/auth/OAuthButtons.tsx).
 */

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const loadedScripts = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let pending = loadedScripts.get(src);
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loadedScripts.delete(src);
        reject(new Error(`Failed to load ${src}`));
      };
      document.head.appendChild(script);
    });
    loadedScripts.set(src, pending);
  }
  return pending;
}

// ── Google Identity Services ──

export interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    nonce?: string;
    ux_mode?: 'popup' | 'redirect';
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'large' | 'medium' | 'small';
      text?: 'signin_with' | 'signup_with' | 'continue_with';
      shape?: 'rectangular' | 'pill';
      logo_alignment?: 'left' | 'center';
      width?: number;
    },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
    AppleID?: AppleIdApi;
  }
}

export async function loadGoogleIdentity(): Promise<GoogleIdApi> {
  await loadScript('https://accounts.google.com/gsi/client');
  const api = window.google?.accounts?.id;
  if (!api) throw new Error('Google Identity Services failed to initialize');
  return api;
}

// ── Sign in with Apple JS ──

export interface AppleSignInResponse {
  authorization: {
    id_token: string;
    code: string;
    state?: string;
  };
  /** Only present on the user's first authorization for this app. */
  user?: {
    name?: { firstName?: string; lastName?: string };
    email?: string;
  };
}

interface AppleIdApi {
  auth: {
    init(config: {
      clientId: string;
      scope: string;
      redirectURI: string;
      nonce?: string;
      usePopup?: boolean;
    }): void;
    signIn(): Promise<AppleSignInResponse>;
  };
}

export async function loadAppleId(): Promise<AppleIdApi> {
  await loadScript(
    'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js',
  );
  const api = window.AppleID;
  if (!api) throw new Error('Sign in with Apple failed to initialize');
  return api;
}
