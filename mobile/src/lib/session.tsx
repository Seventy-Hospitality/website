/**
 * Bearer-session auth provider for the mobile app, at full parity with the
 * web client's contract translated to token transport.
 *
 * Session truth is GET /api/auth/me (the Principal). Auth mutations (password
 * sign in/up, OAuth, magic link) return the bearer token pair in the body
 * (X-Client-Type: mobile); we persist access + refresh + expiry to
 * SecureStore, then read /api/auth/me for the authoritative Principal. The
 * API pipeline reads the token through an injected AuthBridge and, on a 401,
 * runs one single-flight refresh; a failed refresh calls back into
 * `onSessionInvalid` here to sign the session out.
 *
 * useSession() exposes status/user plus the emailVerified/memberId/onboarding
 * flags and OAuth-configuration flags the flow packages (M1..M6) consume.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  refreshSessionTokens,
  setApiToken,
  setAuthBridge,
  type IssuedSession,
  type Principal,
  type SessionTokens,
} from './api';
import {
  appleAdapter,
  authenticateWithProvider,
  googleAdapter,
  type FederatedAdapter,
} from './oauth';
import { queryClient } from './query-client';
import { clearStoredSession, getStoredSession, setStoredSession } from './storage';

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

export interface OAuthConfig {
  googleConfigured: boolean;
  appleConfigured: boolean;
}

export interface SessionContextValue {
  status: SessionStatus;
  /** The signed-in Principal, or null while loading / anonymous. */
  principal: Principal | null;
  /** Alias kept for existing call sites. */
  user: Principal | null;
  emailVerified: boolean;
  memberId: string | null;
  /** Signed in but the member profile does not exist yet (onboarding gate). */
  needsOnboarding: boolean;
  /** Which OAuth providers are configured (buttons degrade otherwise). */
  oauth: OAuthConfig;

  signInWithPassword: (input: { email: string; password: string }) => Promise<Principal>;
  signUpWithPassword: (input: {
    name: string;
    email: string;
    password: string;
    phone?: string;
  }) => Promise<Principal>;
  requestMagicLink: (email: string, redirectTo: string) => Promise<void>;
  completeMagicLink: (tokens: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
  }) => Promise<Principal>;
  signInWithGoogle: () => Promise<Principal>;
  signInWithApple: () => Promise<Principal>;
  verifyEmail: (token: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  resetPassword: (input: { token: string; password: string }) => Promise<void>;
  /** Re-read /api/auth/me (call after anything that changes the Principal). */
  refresh: () => Promise<Principal | null>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const tokensRef = useRef<SessionTokens | null>(null);

  const persist = useCallback((tokens: SessionTokens) => {
    tokensRef.current = tokens;
    setApiToken(tokens.accessToken);
    void setStoredSession({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    });
  }, []);

  const clearSession = useCallback(() => {
    tokensRef.current = null;
    setApiToken(null);
    void clearStoredSession();
    queryClient.clear();
    setPrincipal(null);
    setStatus('anonymous');
  }, []);

  // Install the bridge the API pipeline reads the token and refresh through.
  useEffect(() => {
    setAuthBridge({
      getAccessToken: () => tokensRef.current?.accessToken ?? null,
      getRefreshToken: () => tokensRef.current?.refreshToken ?? null,
      onTokensRefreshed: (tokens) => persist(tokens),
      onSessionInvalid: () => clearSession(),
    });
    return () => setAuthBridge(null);
  }, [persist, clearSession]);

  /** Persist a token pair, then read the authoritative Principal. */
  const establishSession = useCallback(
    async (tokens: SessionTokens): Promise<Principal> => {
      persist(tokens);
      const me = await api.getMe();
      if (!me) {
        clearSession();
        throw new Error('Unable to load session');
      }
      setPrincipal(me);
      setStatus('authenticated');
      return me;
    },
    [persist, clearSession],
  );

  const establishFromIssued = useCallback(
    (issued: IssuedSession) =>
      establishSession({
        accessToken: issued.accessToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
        refreshToken: issued.refreshToken,
        refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
      }),
    [establishSession],
  );

  // Cold-start bootstrap: restore the stored session, refreshing if the
  // access token is already dead but the refresh token still lives.
  useEffect(() => {
    let mounted = true;

    (async () => {
      const stored = await getStoredSession();
      if (!stored) {
        if (mounted) setStatus('anonymous');
        return;
      }

      tokensRef.current = {
        accessToken: stored.accessToken,
        accessTokenExpiresAt: stored.accessTokenExpiresAt,
        refreshToken: stored.refreshToken,
        refreshTokenExpiresAt: '',
      };
      setApiToken(stored.accessToken);

      try {
        let me = await api.getMe();
        if (!me && stored.refreshToken) {
          try {
            const issued = await refreshSessionTokens(stored.refreshToken);
            persist({
              accessToken: issued.accessToken,
              accessTokenExpiresAt: issued.accessTokenExpiresAt,
              refreshToken: issued.refreshToken,
              refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
            });
            me = await api.getMe();
          } catch {
            // Refresh token is dead too; fall through to anonymous.
          }
        }

        if (!mounted) return;
        if (me) {
          setPrincipal(me);
          setStatus('authenticated');
        } else {
          tokensRef.current = null;
          setApiToken(null);
          await clearStoredSession();
          setStatus('anonymous');
        }
      } catch {
        if (!mounted) return;
        tokensRef.current = null;
        setApiToken(null);
        await clearStoredSession();
        setStatus('anonymous');
      }
    })();

    return () => {
      mounted = false;
    };
  }, [persist]);

  const signInWithFederated = useCallback(
    async (adapter: FederatedAdapter): Promise<Principal> => {
      const result = await authenticateWithProvider(adapter, api.oauthNonce);
      const issued =
        result.provider === 'google'
          ? await api.oauthGoogle({ idToken: result.idToken, nonce: result.rawNonce })
          : await api.oauthApple({
              identityToken: result.idToken,
              nonce: result.rawNonce,
              fullName: result.fullName,
            });
      return establishFromIssued(issued);
    },
    [establishFromIssued],
  );

  const value = useMemo<SessionContextValue>(() => {
    return {
      status,
      principal,
      user: principal,
      emailVerified: principal?.emailVerified ?? false,
      memberId: principal?.memberId ?? null,
      needsOnboarding: principal !== null && principal.memberId === null,
      oauth: {
        googleConfigured: googleAdapter.isConfigured(),
        appleConfigured: appleAdapter.isConfigured(),
      },

      async signInWithPassword(input) {
        return establishFromIssued(await api.signIn(input));
      },
      async signUpWithPassword(input) {
        return establishFromIssued(await api.signUp(input));
      },
      async requestMagicLink(email, redirectTo) {
        await api.sendMagicLink(email, redirectTo);
      },
      async completeMagicLink(tokens) {
        return establishSession({
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          refreshToken: tokens.refreshToken,
          refreshTokenExpiresAt: '',
        });
      },
      signInWithGoogle: () => signInWithFederated(googleAdapter),
      signInWithApple: () => signInWithFederated(appleAdapter),
      async verifyEmail(token) {
        await api.verifyEmail(token);
        // The Principal's emailVerified flips; pull the fresh one.
        const me = await api.getMe();
        if (me) setPrincipal(me);
      },
      async resendVerification() {
        await api.resendVerification();
      },
      async forgotPassword(email) {
        await api.forgotPassword(email);
      },
      async resetPassword(input) {
        await api.resetPassword(input);
      },
      async refresh() {
        const me = await api.getMe();
        setPrincipal(me);
        setStatus(me ? 'authenticated' : 'anonymous');
        return me;
      },
      async signOut() {
        try {
          if (tokensRef.current) await api.signOut();
        } finally {
          clearSession();
        }
      },
    };
  }, [status, principal, establishSession, establishFromIssued, signInWithFederated, clearSession]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used within SessionProvider');
  }
  return value;
}
