import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../../lib/session-context';
import { ButtonLink, FullScreenLoader } from '../../components';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

/**
 * Neutral post-auth landing. The magic-link flow (GET /api/auth/verify) sets
 * the session cookies server-side and redirects the browser here; we confirm
 * the session and hand off into the app. Also serves as the registered
 * redirectURI for the Apple JS popup (which never actually navigates here).
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refreshSession } = useSession();
  const [failed, setFailed] = useState(false);

  const errorParam = searchParams.get('error');

  const fired = useRef(false);
  useEffect(() => {
    if (errorParam || fired.current) return;
    fired.current = true;
    refreshSession().then((principal) => {
      if (principal) {
        navigate('/', { replace: true });
      } else {
        setFailed(true);
      }
    });
  }, [errorParam, refreshSession, navigate]);

  if (errorParam || failed) {
    return (
      <AuthLayout title="Sign-in failed">
        <p className={styles.statusBody}>
          We could not complete your sign-in. The link may have expired; request a fresh one and
          try again.
        </p>
        <ButtonLink to="/sign-in" fullWidth>
          Back to sign in
        </ButtonLink>
      </AuthLayout>
    );
  }

  return <FullScreenLoader label="Completing sign-in" />;
}
