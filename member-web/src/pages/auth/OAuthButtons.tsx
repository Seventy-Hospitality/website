/**
 * "Continue with Google" / "Continue with Apple" per the Figma.
 *
 * Wiring (see lib/oauth.ts for the nonce contract): each sign-in fetches a
 * single-use nonce from the backend, hands the provider SDK sha256(nonce),
 * and POSTs the resulting ID token plus the raw nonce to the verify
 * endpoint. On success the backend sets the session cookies; we refresh
 * /api/auth/me and navigate into the app.
 *
 * Google's ID-token flow requires rendering the official GIS button, so the
 * Google slot hosts it (pill theme, sized to the column). Apple permits
 * custom buttons, so that one matches the Figma exactly.
 *
 * Degradation: with no client ID configured, each button renders disabled
 * with a "not configured" note, and no third-party script is loaded.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError, type OAuthAppleInput } from '../../lib/api';
import { APPLE_CLIENT_ID, GOOGLE_CLIENT_ID } from '../../lib/env';
import {
  loadAppleId,
  loadGoogleIdentity,
  sha256Hex,
  type GoogleCredentialResponse,
} from '../../lib/oauth';
import { redirectAfterAuth, useSession } from '../../lib/session-context';
import { Button, useToast } from '../../components';
import styles from './auth.module.css';

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.87c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.29a12 12 0 0 0 0 10.74l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.6 4.59 1.79l3.44-3.44A11.98 11.98 0 0 0 1.29 6.63l3.98 3.09C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
      <path d="M17.05 12.54c-.03-2.9 2.37-4.29 2.48-4.36-1.35-1.97-3.45-2.24-4.2-2.27-1.79-.18-3.49 1.05-4.4 1.05-.9 0-2.3-1.03-3.79-1-1.95.03-3.74 1.13-4.74 2.87-2.02 3.5-.52 8.69 1.45 11.53.96 1.39 2.11 2.95 3.62 2.9 1.45-.06 2-.94 3.75-.94s2.25.94 3.79.91c1.56-.03 2.55-1.42 3.51-2.82 1.1-1.62 1.55-3.19 1.58-3.27-.04-.02-3.03-1.16-3.05-4.6ZM14.16 4.03c.8-.97 1.34-2.32 1.19-3.66-1.15.05-2.55.77-3.38 1.74-.74.86-1.39 2.23-1.22 3.55 1.29.1 2.6-.65 3.41-1.63Z" />
    </svg>
  );
}

/** Apple's popup rejects with { error: 'popup_closed_by_user' } on cancel. */
function isAppleCancellation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    (error as { error: unknown }).error === 'popup_closed_by_user'
  );
}

export function OAuthButtons({ intent }: { intent: 'signin' | 'signup' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshSession } = useSession();
  const { toast } = useToast();

  const googleSlotRef = useRef<HTMLDivElement>(null);
  const googleNonceRef = useRef<string | null>(null);
  const [googleFailed, setGoogleFailed] = useState(false);

  const finishSignIn = async () => {
    await refreshSession();
    navigate(redirectAfterAuth(location), { replace: true });
  };

  const googleMutation = useMutation({
    mutationFn: (input: { idToken: string; nonce: string }) => api.oauthGoogle(input),
    onSuccess: finishSignIn,
    onError: (error) => {
      toast({
        variant: 'error',
        message:
          error instanceof ApiError && error.status === 401
            ? 'Google sign-in was rejected. Please try again.'
            : 'Google sign-in failed. Please try again.',
      });
    },
  });
  // react-query's `mutate` is referentially stable, so the GIS callback can
  // close over it without going stale.
  const { mutate: googleMutate } = googleMutation;

  // Mount the official GIS button when Google is configured.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    (async () => {
      try {
        const [gis, { nonce }] = await Promise.all([loadGoogleIdentity(), api.oauthNonce()]);
        if (cancelled || !googleSlotRef.current) return;
        googleNonceRef.current = nonce;
        gis.initialize({
          client_id: GOOGLE_CLIENT_ID,
          nonce: await sha256Hex(nonce),
          ux_mode: 'popup',
          callback: (response: GoogleCredentialResponse) => {
            const rawNonce = googleNonceRef.current;
            if (!rawNonce) return;
            googleMutate({ idToken: response.credential, nonce: rawNonce });
          },
        });
        gis.renderButton(googleSlotRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          logo_alignment: 'center',
          text: intent === 'signup' ? 'signup_with' : 'signin_with',
          width: Math.min(googleSlotRef.current.offsetWidth || 400, 400),
        });
      } catch {
        if (!cancelled) setGoogleFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [intent, googleMutate]);

  const appleMutation = useMutation({
    mutationFn: async () => {
      // Fresh nonce per attempt; Apple's init accepts being called again.
      const [appleId, { nonce }] = await Promise.all([loadAppleId(), api.oauthNonce()]);
      appleId.auth.init({
        clientId: APPLE_CLIENT_ID!,
        scope: 'name email',
        redirectURI: `${window.location.origin}/auth/callback`,
        nonce: await sha256Hex(nonce),
        usePopup: true,
      });
      const response = await appleId.auth.signIn();
      const name = response.user?.name;
      const input: OAuthAppleInput = {
        identityToken: response.authorization.id_token,
        nonce,
        authorizationCode: response.authorization.code,
        fullName: name ? { givenName: name.firstName, familyName: name.lastName } : undefined,
      };
      return api.oauthApple(input);
    },
    onSuccess: finishSignIn,
    onError: (error) => {
      if (isAppleCancellation(error)) return;
      toast({ variant: 'error', message: 'Apple sign-in failed. Please try again.' });
    },
  });

  const googleConfigured = Boolean(GOOGLE_CLIENT_ID) && !googleFailed;
  const appleConfigured = Boolean(APPLE_CLIENT_ID);
  const unavailable = [
    !googleConfigured && 'Google',
    !appleConfigured && 'Apple',
  ].filter(Boolean);

  return (
    <div className={styles.oauthStack}>
      {googleConfigured ? (
        <div ref={googleSlotRef} className={styles.googleSlot} aria-busy={googleMutation.isPending} />
      ) : (
        <Button
          variant="secondary"
          fullWidth
          icon={<GoogleGlyph />}
          className={styles.oauthButton}
          disabled
          title="Google sign-in is not configured in this environment"
        >
          Continue with Google
        </Button>
      )}

      <Button
        variant="secondary"
        fullWidth
        icon={<AppleGlyph />}
        className={styles.oauthButton}
        disabled={!appleConfigured}
        loading={appleMutation.isPending}
        title={
          appleConfigured ? undefined : 'Apple sign-in is not configured in this environment'
        }
        onClick={() => appleMutation.mutate()}
      >
        Continue with Apple
      </Button>

      {unavailable.length > 0 && (
        <p className={styles.oauthUnavailable}>
          {unavailable.join(' and ')} sign-in {unavailable.length > 1 ? 'are' : 'is'} not
          configured in this environment.
        </p>
      )}
    </div>
  );
}
