/**
 * Typed API client for the member app.
 *
 * Sessions are httpOnly cookies (never tokens in JS): every request carries
 * `credentials: 'include'`, and auth calls add `X-Client-Type: web` so the
 * backend issues cookies instead of body tokens. Session truth is always
 * `GET /api/auth/me`; auth mutation responses are only used for their
 * success/failure signal.
 *
 * In dev, Vite proxies /api/* to the API server (see vite.config.ts).
 * In production the API container serves this bundle same-origin.
 *
 * Flow packages extend the `api` object below with their own endpoint
 * groups; keep it organized by domain with a comment per group.
 */
import { API_URL } from './env';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The authenticated caller, as returned by GET /api/auth/me. */
export interface Principal {
  userId: string;
  email: string;
  emailVerified: boolean;
  staffRole: 'staff' | 'admin' | null;
  memberId: string | null;
  client: string;
}

/** Serialized identity user returned in auth mutation bodies (no tokens on web). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: string | null;
  staffRole: 'staff' | 'admin' | null;
}

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

export interface OAuthAppleInput {
  identityToken: string;
  nonce: string;
  authorizationCode?: string;
  fullName?: { givenName?: string; familyName?: string };
}

function normalizeJsonResponse(text: string) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isAuthPath(path: string): boolean {
  return path.startsWith('/api/auth/');
}

/**
 * Single-flight session refresh. When any request hits a 401 we try one
 * cookie refresh (POST /api/auth/refresh rotates the httpOnly cookies) and
 * retry the request once; concurrent 401s share the same refresh attempt.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Client-Type': 'web' },
        body: '{}',
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function performRequest(path: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  const isFormDataBody = typeof FormData !== 'undefined' && options?.body instanceof FormData;

  if (!isFormDataBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (isAuthPath(path)) {
    // The backend derives cookie-vs-bearer transport from this header.
    headers.set('X-Client-Type', 'web');
  }

  return fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...options,
    headers,
  });
}

/**
 * Core request pipeline. Flow packages define their endpoints on `api`
 * below in terms of this helper; avoid calling it ad hoc from components.
 */
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res = await performRequest(path, options);

  // Expired access cookie: refresh once and retry. Auth endpoints are
  // excluded; /me returning 401 means "signed out", not "retry".
  if (res.status === 401 && !isAuthPath(path)) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await performRequest(path, options);
    }
  }

  const text = await res.text();
  const json = normalizeJsonResponse(text);

  if (!res.ok) {
    throw new ApiError(
      json.error?.code ?? 'UNKNOWN',
      json.error?.message ?? 'Request failed',
      res.status,
      json.error?.details,
    );
  }

  return json.data;
}

export const api = {
  // ── Session ──
  getMe: () => request<Principal | null>('/api/auth/me'),
  signOut: () => request<{ signedOut: true }>('/api/auth/signout', { method: 'POST' }),

  // ── Password auth ──
  signUp: (input: SignUpInput) =>
    request<{ user: AuthUser }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  signIn: (input: { email: string; password: string }) =>
    request<{ user: AuthUser }>('/api/auth/signin', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── OAuth (Google Identity Services / Sign in with Apple JS) ──
  oauthNonce: () =>
    request<{ nonce: string; expiresAt: string }>('/api/auth/oauth/nonce', { method: 'POST' }),
  oauthGoogle: (input: { idToken: string; nonce: string }) =>
    request<{ user: AuthUser }>('/api/auth/oauth/google', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  oauthApple: (input: OAuthAppleInput) =>
    request<{ user: AuthUser }>('/api/auth/oauth/apple', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── Magic link ──
  requestMagicLink: (email: string) =>
    request<{ sent: true }>('/api/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  // ── Password reset ──
  forgotPassword: (email: string) =>
    request<{ sent: true }>('/api/auth/password/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetPassword: (input: { token: string; password: string }) =>
    request<{ reset: true }>('/api/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── Email verification ──
  verifyEmail: (token: string) =>
    request<{ verified: true; memberClaimed: boolean }>('/api/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  resendVerification: () =>
    request<{ sent: true }>('/api/auth/email/resend', { method: 'POST' }),
};
