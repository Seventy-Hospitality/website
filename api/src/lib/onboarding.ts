/**
 * Onboarding resume state (GET /api/me/onboarding): the server-side twin of
 * the resolver the web client previously reconstructed from three separate
 * reads. Pure so it is testable; the route composes the existing
 * membership + id-verification reads and hands the facts here.
 *
 * Step semantics (kept exactly in line with the shipped web flow):
 * - No member profile yet: a signup whose email matched a staff-created
 *   member row claims it only once the email is verified, so a missing
 *   profile means "verify your email" (or, verified but still missing, a
 *   broken account the client surfaces support UI for, never a redirect
 *   loop).
 * - With a profile, email verification does NOT gate the purchase steps
 *   (the shipped flow lets an unverified signup pick a plan and pay).
 * - A membership that was ever live (active, trialing, past_due, unpaid,
 *   paused, even canceled) counts as past the purchase steps: lapsed
 *   members are a renewal concern, not an onboarding one.
 * - The ID step remains until answered one way or the other: submitted,
 *   verified or rejected is an answer; a recorded skip is an answer; a
 *   fresh not_submitted still gates.
 */

export type OnboardingNextStep =
  | 'verify-email'
  | 'no-profile'
  | 'plan'
  | 'checkout'
  | 'identity'
  | 'done';

export type OnboardingIdStatus = 'not_submitted' | 'submitted' | 'verified' | 'rejected';

export interface OnboardingFacts {
  emailVerified: boolean;
  hasMemberProfile: boolean;
  /** Stripe-shaped membership status of the current membership; null without one. */
  membershipStatus: string | null;
  idVerificationStatus: OnboardingIdStatus;
  idVerificationSkipped: boolean;
}

export function resolveOnboardingNextStep(facts: OnboardingFacts): OnboardingNextStep {
  if (!facts.hasMemberProfile) {
    return facts.emailVerified ? 'no-profile' : 'verify-email';
  }

  const status = facts.membershipStatus;
  if (status === null || status === 'incomplete_expired') return 'plan';
  if (status === 'incomplete') return 'checkout';

  if (facts.idVerificationStatus === 'not_submitted' && !facts.idVerificationSkipped) {
    return 'identity';
  }
  return 'done';
}

/** Whether the membership got past payment at least once (see above). */
export function membershipEverLive(status: string | null): boolean {
  return status !== null && status !== 'incomplete' && status !== 'incomplete_expired';
}
