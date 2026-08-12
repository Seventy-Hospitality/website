/**
 * Session context contract. The provider and route guards live in
 * session.tsx; this module holds the context object, types, and hooks so
 * component files export only components (fast-refresh friendly).
 */
import { createContext, useContext } from 'react';
import type { Location } from 'react-router-dom';
import type { Principal } from './api';

export const SESSION_QUERY_KEY = ['auth', 'me'] as const;

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

export interface SessionContextValue {
  status: SessionStatus;
  /** The signed-in Principal, or null while loading / anonymous. */
  principal: Principal | null;
  /** Convenience flags for gating (W1 gates onboarding on these). */
  emailVerified: boolean;
  /** Null until onboarding creates the member profile. */
  memberId: string | null;
  /** True when signed in but the member profile does not exist yet. */
  needsOnboarding: boolean;
  /** Re-fetch /api/auth/me (call after any auth mutation succeeds). */
  refreshSession: () => Promise<Principal | null>;
  /** Revoke the session server-side and drop all cached data. */
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used within SessionProvider');
  }
  return value;
}

/** Where to land after successful auth: the guarded page that sent us here, else home. */
export function redirectAfterAuth(location: Location): string {
  const from = (location.state as { from?: Location } | null)?.from;
  return from ? `${from.pathname}${from.search}` : '/';
}
