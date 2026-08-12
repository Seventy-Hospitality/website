/**
 * The onboarding-resume gate (package M1), native mirror of member-web's
 * OnboardingGate. Applies the resolved step (useOnboardingResume) in both
 * directions:
 *
 * - OnboardingEntry is the authenticated landing (app/index.tsx). It sends a
 *   fully onboarded member to the tabs and a not-yet-onboarded member into
 *   their step, so every signed-in entry funnels through one decision.
 * - OnboardingLayoutGate wraps the /onboarding/* stack (app/onboarding/
 *   _layout.tsx). It bounces a done member out to the tabs and enforces step
 *   order within the flow (a step cannot be skipped, and a paid member cannot
 *   reopen the purchase steps).
 *
 * The verified-but-profileless "no-profile" case is surfaced as support UI in
 * place, never redirected (that would loop).
 */
import { Redirect, Stack, usePathname } from 'expo-router';
import { useSession } from '../../lib/session';
import { canVisitOnboardingPath, onboardingPathForStep } from './onboarding';
import { useOnboardingResume } from './useOnboardingResume';
import { GateError, GateLoading, NoProfileScreen } from './components/GateStates';

/** app/index.tsx (authenticated): route to the tabs or the resume step. */
export function OnboardingEntry() {
  const { refresh, signOut } = useSession();
  const resume = useOnboardingResume();

  if (resume.phase === 'loading') return <GateLoading />;
  if (resume.phase === 'error') return <GateError onRetry={resume.refetch} />;

  if (resume.step === 'no-profile') {
    return <NoProfileScreen onRefresh={refresh} onSignOut={signOut} />;
  }
  if (resume.step === 'done') return <Redirect href="/(tabs)" />;
  return <Redirect href={onboardingPathForStep(resume.step)} />;
}

/** app/onboarding/_layout.tsx: gate + render the onboarding stack. */
export function OnboardingLayoutGate() {
  const { status, refresh, signOut } = useSession();
  const pathname = usePathname();
  const resume = useOnboardingResume();

  if (status === 'anonymous') return <Redirect href="/auth/sign-in" />;

  if (resume.phase === 'loading') return <GateLoading label="Loading your session" />;
  if (resume.phase === 'error') return <GateError onRetry={resume.refetch} />;

  if (resume.step === 'no-profile') {
    return <NoProfileScreen onRefresh={refresh} onSignOut={signOut} />;
  }
  if (resume.step === 'done') return <Redirect href="/(tabs)" />;

  // Within the flow, hold the member to the route their step allows.
  if (!canVisitOnboardingPath(resume.step, pathname)) {
    return <Redirect href={onboardingPathForStep(resume.step)} />;
  }

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />;
}
