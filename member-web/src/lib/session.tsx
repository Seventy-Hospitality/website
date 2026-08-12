/**
 * Cookie-session auth provider and route guards. Ports the admin web
 * AuthGuard and the mobile SessionProvider into one react-query-backed
 * context: session truth is GET /api/auth/me (the Principal), cached under
 * SESSION_QUERY_KEY. Auth mutations (sign in/up, OAuth, magic link) set
 * httpOnly cookies server-side and then call `refreshSession()` to pull the
 * new Principal. The contract types and useSession live in
 * session-context.ts.
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import {
  SESSION_QUERY_KEY,
  SessionContext,
  redirectAfterAuth,
  useSession,
  type SessionContextValue,
  type SessionStatus,
} from './session-context';
import { FullScreenLoader } from '../components/Spinner';

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isPending } = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: api.getMe,
    // The session changes only through auth mutations (which refresh it
    // explicitly) or expiry (which surfaces as a 401 -> refresh -> retry in
    // the API client), so no background polling.
    staleTime: 5 * 60_000,
    retry: false,
  });

  const principal = data ?? null;
  const status: SessionStatus = isPending ? 'loading' : principal ? 'authenticated' : 'anonymous';

  const refreshSession = useCallback(async () => {
    const next = await queryClient.fetchQuery({
      queryKey: SESSION_QUERY_KEY,
      queryFn: api.getMe,
      staleTime: 0,
    });
    return next ?? null;
  }, [queryClient]);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } catch {
      // Cookies may already be gone (expired session); treat as signed out.
    }
    // Drop every cached query: nothing user-scoped may survive a sign-out.
    queryClient.clear();
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
  }, [queryClient]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      principal,
      emailVerified: principal?.emailVerified ?? false,
      memberId: principal?.memberId ?? null,
      needsOnboarding: principal !== null && principal.memberId === null,
      refreshSession,
      signOut,
    }),
    [status, principal, refreshSession, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Route guard for the member app. Renders child routes only for a signed-in
 * session; anonymous visitors are sent to /sign-in with the attempted
 * location preserved so sign-in can return them there.
 */
export function MemberAuthGuard() {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'loading') return <FullScreenLoader label="Loading your session" />;
  if (status === 'anonymous') {
    return <Navigate to="/sign-in" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

/**
 * Inverse guard for the auth screens: a signed-in member has no business on
 * /sign-in, so bounce to the app (or wherever they originally wanted to go).
 */
export function AnonymousOnly() {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'loading') return <FullScreenLoader label="Loading your session" />;
  if (status === 'authenticated') {
    return <Navigate to={redirectAfterAuth(location)} replace />;
  }
  return <Outlet />;
}
