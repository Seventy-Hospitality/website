/**
 * Combines the session Principal with the GET /api/me/onboarding read into a
 * single resolved onboarding step, so both the app-entry gate
 * (OnboardingEntry) and the onboarding-stack gate (OnboardingLayoutGate)
 * decide routing from one source of truth.
 *
 * emailVerified/memberId come from the authoritative Principal (useSession);
 * the membership + ID-verification facts come from the onboarding read. The
 * pure resolver (onboarding.ts) turns those into the step.
 */
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../lib/session';
import { resolveOnboardingStep, type OnboardingStep } from './onboarding';
import { onboardingQuery } from './queries';

export type ResumePhase =
  | { phase: 'loading' }
  | { phase: 'error'; refetch: () => void }
  | { phase: 'ready'; step: OnboardingStep };

export function useOnboardingResume(): ResumePhase {
  const { status, emailVerified, memberId } = useSession();
  const enabled = status === 'authenticated';
  const onboarding = useQuery({ ...onboardingQuery, enabled });

  if (status === 'loading') return { phase: 'loading' };

  // Signed out: nothing to resolve; callers redirect to auth on their own.
  // Treat as loading so the gate holds rather than resolving a bogus step.
  if (status === 'anonymous') return { phase: 'loading' };

  if (onboarding.isPending) return { phase: 'loading' };
  if (onboarding.isError) {
    return { phase: 'error', refetch: () => void onboarding.refetch() };
  }

  const step = resolveOnboardingStep({
    emailVerified,
    memberId,
    membership: onboarding.data.membership,
    idVerification: onboarding.data.idVerification,
  });
  return { phase: 'ready', step };
}
