import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, UserRoundX } from 'lucide-react';
import { useSession } from '../../lib/session-context';
import {
  canVisitOnboardingPath,
  onboardingPathForStep,
  resolveOnboardingStep,
} from '../../lib/onboarding';
import { idVerificationQuery, membershipQuery } from './onboarding-data';
import { Button, EmptyState, FullScreenLoader } from '../../components';
import styles from './onboarding.module.css';

/**
 * Onboarding-resume gate (package W1). Wraps BOTH the onboarding routes and
 * the tab shell, and enforces the resolved step in both directions:
 *
 * - a signed-in user who has not finished onboarding is pushed to their
 *   step (verify email -> choose plan -> checkout -> ID) wherever they land;
 * - a fully onboarded member who navigates into /onboarding/* is sent home;
 * - within /onboarding/*, steps cannot be skipped (checkout before a plan
 *   purchase exists is allowed only alongside plan selection; the ID step
 *   requires a paid membership).
 *
 * Step resolution is pure (src/lib/onboarding.ts) over the session
 * Principal plus the membership and ID-verification reads.
 */
export function OnboardingGate() {
  const { status, principal, emailVerified, signOut, refreshSession } = useSession();
  const location = useLocation();

  const hasProfile = principal?.memberId != null;
  const membership = useQuery({ ...membershipQuery, enabled: hasProfile });
  const idVerification = useQuery({ ...idVerificationQuery, enabled: hasProfile });

  // MemberAuthGuard already holds this route back while the session loads;
  // guard again so the gate never resolves a step from a null principal.
  if (status === 'loading') {
    return <FullScreenLoader label="Loading your session" />;
  }

  if (hasProfile && (membership.isPending || idVerification.isPending)) {
    return <FullScreenLoader label="Loading your membership" />;
  }

  if (membership.isError || idVerification.isError) {
    return (
      <GateError
        onRetry={() => {
          if (membership.isError) void membership.refetch();
          if (idVerification.isError) void idVerification.refetch();
        }}
      />
    );
  }

  const step = resolveOnboardingStep({
    emailVerified,
    memberId: principal?.memberId ?? null,
    membership: membership.data?.membership ?? null,
    idVerification: idVerification.data ?? null,
  });

  // Verified email but no member profile: a broken account. Redirecting
  // anywhere would loop (the verify screen bounces verified users back), so
  // surface it directly with a way out.
  if (step === 'no-profile') {
    return <NoProfileScreen onRefresh={refreshSession} onSignOut={signOut} />;
  }

  if (location.pathname.startsWith('/onboarding')) {
    if (!canVisitOnboardingPath(step, location.pathname)) {
      return <Navigate to={onboardingPathForStep(step)} replace />;
    }
    return <Outlet />;
  }

  if (step !== 'done') {
    return <Navigate to={onboardingPathForStep(step)} replace />;
  }
  return <Outlet />;
}

function GateError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.gateError}>
      <div className={styles.gateErrorColumn}>
        <EmptyState
          icon={<RefreshCw aria-hidden />}
          title="We could not load your membership"
          description="Check your connection and try again."
          action={<Button onClick={onRetry}>Try again</Button>}
        />
      </div>
    </div>
  );
}

function NoProfileScreen({
  onRefresh,
  onSignOut,
}: {
  onRefresh: () => Promise<unknown>;
  onSignOut: () => Promise<void>;
}) {
  const refresh = useMutation({ mutationFn: onRefresh });
  const signOut = useMutation({ mutationFn: onSignOut });

  return (
    <div className={styles.gateError}>
      <div className={styles.gateErrorColumn}>
        <EmptyState
          icon={<UserRoundX aria-hidden />}
          title="We could not find your member profile"
          description="Your account is not linked to a club member profile yet. Contact the club to get set up, or sign out and use a different account."
          action={
            <div className={styles.actionRow}>
              <Button loading={refresh.isPending} onClick={() => refresh.mutate()}>
                Check again
              </Button>
              <Button
                variant="ghost"
                loading={signOut.isPending}
                onClick={() => signOut.mutate()}
              >
                Sign out
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}
