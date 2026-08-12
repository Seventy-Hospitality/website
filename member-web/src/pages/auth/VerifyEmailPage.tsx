import { useEffect, useRef } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session-context';
import { Button, ButtonLink, FullScreenLoader, useToast } from '../../components';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

/**
 * Two jobs in one route:
 * - /verify-email?token=...  the emailed verification link; burns the token
 *   (works signed in or out).
 * - /verify-email            the signed-in prompt shown after sign-up, with
 *   resend. W1 gates onboarding steps on session.emailVerified.
 */
export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const { status, principal, refreshSession } = useSession();
  const { toast } = useToast();

  const verify = useMutation({
    mutationFn: (verifyToken: string) => api.verifyEmail(verifyToken),
    onSuccess: async () => {
      // emailVerified changed; pick up the fresh Principal.
      await refreshSession();
    },
  });

  const resend = useMutation({
    mutationFn: () => api.resendVerification(),
    onSuccess: () => toast({ variant: 'success', message: 'Verification email sent.' }),
    onError: () =>
      toast({ variant: 'error', message: 'Could not send the email. Please try again.' }),
  });

  // Burn the token exactly once (StrictMode double-invokes effects in dev).
  const fired = useRef(false);
  useEffect(() => {
    if (token && !fired.current) {
      fired.current = true;
      verify.mutate(token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (token) {
    if (verify.isSuccess) {
      return (
        <AuthLayout title="Email verified">
          <p className={styles.statusBody}>You are all set.</p>
          <ButtonLink to="/" fullWidth>
            Continue
          </ButtonLink>
        </AuthLayout>
      );
    }
    if (verify.isError) {
      return (
        <AuthLayout title="Link expired">
          <p className={styles.statusBody}>
            This verification link is invalid or has expired.
            {principal ? ' Send yourself a fresh one below.' : ' Sign in to request a new one.'}
          </p>
          {principal ? (
            <Button fullWidth loading={resend.isPending} onClick={() => resend.mutate()}>
              Resend verification email
            </Button>
          ) : (
            <ButtonLink to="/sign-in" fullWidth>
              Sign in
            </ButtonLink>
          )}
        </AuthLayout>
      );
    }
    return <FullScreenLoader label="Verifying your email" />;
  }

  // Prompt mode requires a session.
  if (status === 'loading') return <FullScreenLoader label="Loading your session" />;
  if (status === 'anonymous') return <Navigate to="/sign-in" replace />;
  if (principal?.emailVerified) return <Navigate to="/" replace />;

  return (
    <AuthLayout title="Verify your email">
      <p className={styles.statusBody}>
        We sent a verification link to{' '}
        <span className={styles.statusEmail}>{principal?.email}</span>. Click it to confirm your
        address.
      </p>
      <Button fullWidth loading={resend.isPending} onClick={() => resend.mutate()}>
        Resend email
      </Button>
      <ButtonLink to="/" variant="ghost" fullWidth>
        Continue for now
      </ButtonLink>
    </AuthLayout>
  );
}
