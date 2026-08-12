/**
 * Onboarding-resume logic (package M1), ported from the finished web client
 * (member-web/src/lib/onboarding.ts) and kept pure so it is testable. It is
 * the mobile twin of the server-side resolver behind GET /api/me/onboarding
 * (api/src/lib/onboarding.ts); the two are deliberately kept identical.
 *
 * The resume step is derived from the Principal (email verification + whether
 * a member profile exists) plus the membership + ID-verification facts the
 * GET /api/me/onboarding read returns:
 *   - Signup creates the member profile immediately EXCEPT when the email
 *     matched a staff-created member row, which is claimed only once the email
 *     is verified, so memberId === null means "verify your email first".
 *   - membership status decides whether the purchase steps are done.
 *   - ID verification status/skip decides the final step.
 *
 * OnboardingLayoutGate + OnboardingEntry apply the resolved step in both
 * directions: they push a not-yet-onboarded member into the flow and keep a
 * fully onboarded member out of it.
 */
import type { IdVerificationStatus, MembershipStatus } from '../../lib/api';

/**
 * The version string recorded server-side when the member accepts the Terms
 * and Conditions at checkout. Bump when the terms text changes. Kept in sync
 * with the web client's TERMS_VERSION.
 */
export const TERMS_VERSION = '2026-08';

export type OnboardingStep =
  /** No member profile yet: a claim-pending signup, waiting on email verification. */
  | 'verify-email'
  /** Email verified but still no profile: a broken account; surface support UI, never a redirect loop. */
  | 'no-profile'
  /** No membership chosen yet (or a previous attempt expired). */
  | 'plan'
  /** A plan was chosen and the subscription exists but was never paid. */
  | 'checkout'
  /** Paid, but the government-ID step was neither completed nor skipped. */
  | 'identity'
  /** Fully onboarded; the member belongs in the app. */
  | 'done';

export interface OnboardingStateInput {
  emailVerified: boolean;
  memberId: string | null;
  membership: { status: MembershipStatus } | null;
  idVerification: { status: IdVerificationStatus; skippedAt: string | null } | null;
}

/**
 * Where a returning user resumes:
 *   account made -> plan; plan chosen but unpaid -> checkout; paid -> ID
 *   step; ID submitted or skipped -> done.
 *
 * A membership that was ever live (active, trialing, past_due, unpaid,
 * paused, even canceled) counts as past the purchase steps: lapsed members
 * are a renewal concern (M6), not an onboarding one, and must keep access
 * to the shell (sign out, account deletion).
 */
export function resolveOnboardingStep(input: OnboardingStateInput): OnboardingStep {
  if (input.memberId === null) {
    return input.emailVerified ? 'no-profile' : 'verify-email';
  }

  const status = input.membership?.status ?? null;
  if (status === null || status === 'incomplete_expired') return 'plan';
  if (status === 'incomplete') return 'checkout';

  // Paid (now or in the past): the ID step remains until answered one way
  // or the other. A submitted/verified/rejected ID was answered; a recorded
  // skip was answered; a fresh not_submitted (or an absent read, fail
  // closed) still gates.
  const id = input.idVerification;
  if (!id || (id.status === 'not_submitted' && id.skippedAt === null)) return 'identity';
  return 'done';
}

/** The native route each step lives at. */
export function onboardingPathForStep(step: OnboardingStep): string {
  switch (step) {
    case 'verify-email':
      return '/onboarding/verify-email';
    case 'plan':
      return '/onboarding/plan';
    case 'checkout':
      return '/onboarding/checkout';
    case 'identity':
      return '/onboarding/verify-identity';
    case 'no-profile':
    case 'done':
      return '/(tabs)';
  }
}

/**
 * Which /onboarding/* routes a step may visit. Plan and checkout are
 * interchangeable while unpaid (checkout links back to change the plan, and
 * the subscribe endpoint safely re-enters or replaces an incomplete
 * subscription); the ID step is reachable only once paid, and a done member
 * is bounced out entirely.
 */
export function canVisitOnboardingPath(step: OnboardingStep, pathname: string): boolean {
  switch (step) {
    case 'verify-email':
      return pathname === '/onboarding/verify-email';
    case 'plan':
    case 'checkout':
      return pathname === '/onboarding/plan' || pathname === '/onboarding/checkout';
    case 'identity':
      return pathname === '/onboarding/verify-identity';
    default:
      return false;
  }
}
