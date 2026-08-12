import { describe, expect, it } from 'vitest';
import {
  canVisitOnboardingPath,
  onboardingPathForStep,
  resolveOnboardingStep,
  type OnboardingStateInput,
} from './onboarding';
import type { MembershipStatus } from './api';

function input(overrides: Partial<OnboardingStateInput> = {}): OnboardingStateInput {
  return {
    emailVerified: true,
    memberId: 'm1',
    membership: null,
    idVerification: null,
    ...overrides,
  };
}

const id = (status: 'not_submitted' | 'submitted' | 'verified' | 'rejected', skippedAt: string | null = null) => ({
  status,
  skippedAt,
});

describe('resolveOnboardingStep', () => {
  it('sends a claim-pending account (no profile, unverified email) to verify-email', () => {
    expect(resolveOnboardingStep(input({ memberId: null, emailVerified: false }))).toBe(
      'verify-email',
    );
  });

  it('flags a verified account with no profile as no-profile (support state, no redirect loop)', () => {
    expect(resolveOnboardingStep(input({ memberId: null, emailVerified: true }))).toBe(
      'no-profile',
    );
  });

  it('sends a member with no membership to plan selection', () => {
    expect(resolveOnboardingStep(input())).toBe('plan');
  });

  it('resumes an unpaid purchase at checkout', () => {
    expect(resolveOnboardingStep(input({ membership: { status: 'incomplete' } }))).toBe(
      'checkout',
    );
  });

  it('restarts at plan selection when the unpaid purchase expired', () => {
    expect(resolveOnboardingStep(input({ membership: { status: 'incomplete_expired' } }))).toBe(
      'plan',
    );
  });

  it('sends a paid member with an unanswered ID step to identity', () => {
    expect(
      resolveOnboardingStep(
        input({ membership: { status: 'active' }, idVerification: id('not_submitted') }),
      ),
    ).toBe('identity');
  });

  it.each<MembershipStatus>(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'])(
    'treats a %s membership as past the purchase steps',
    (status) => {
      expect(
        resolveOnboardingStep(input({ membership: { status }, idVerification: id('submitted') })),
      ).toBe('done');
    },
  );

  it('is done once the ID was submitted', () => {
    expect(
      resolveOnboardingStep(
        input({ membership: { status: 'active' }, idVerification: id('submitted') }),
      ),
    ).toBe('done');
  });

  it('is done once the ID step was skipped (status still not_submitted)', () => {
    expect(
      resolveOnboardingStep(
        input({
          membership: { status: 'active' },
          idVerification: id('not_submitted', '2026-08-11T00:00:00.000Z'),
        }),
      ),
    ).toBe('done');
  });

  it('is done for verified and rejected IDs (re-submission is an account concern)', () => {
    for (const status of ['verified', 'rejected'] as const) {
      expect(
        resolveOnboardingStep(
          input({ membership: { status: 'active' }, idVerification: id(status) }),
        ),
      ).toBe('done');
    }
  });

  it('still gates on identity when the ID read is missing for a paid member', () => {
    // Fail closed: without an ID status the member cannot have answered it.
    expect(
      resolveOnboardingStep(input({ membership: { status: 'active' }, idVerification: null })),
    ).toBe('identity');
  });
});

describe('onboardingPathForStep', () => {
  it('maps each step to its route', () => {
    expect(onboardingPathForStep('verify-email')).toBe('/verify-email');
    expect(onboardingPathForStep('plan')).toBe('/onboarding/plan');
    expect(onboardingPathForStep('checkout')).toBe('/onboarding/checkout');
    expect(onboardingPathForStep('identity')).toBe('/onboarding/verify-identity');
    expect(onboardingPathForStep('done')).toBe('/');
    expect(onboardingPathForStep('no-profile')).toBe('/');
  });
});

describe('canVisitOnboardingPath', () => {
  it('lets unpaid members move between plan and checkout but not the ID step', () => {
    for (const step of ['plan', 'checkout'] as const) {
      expect(canVisitOnboardingPath(step, '/onboarding/plan')).toBe(true);
      expect(canVisitOnboardingPath(step, '/onboarding/checkout')).toBe(true);
      expect(canVisitOnboardingPath(step, '/onboarding/verify-identity')).toBe(false);
    }
  });

  it('locks a paid member to the ID step', () => {
    expect(canVisitOnboardingPath('identity', '/onboarding/verify-identity')).toBe(true);
    expect(canVisitOnboardingPath('identity', '/onboarding/plan')).toBe(false);
    expect(canVisitOnboardingPath('identity', '/onboarding/checkout')).toBe(false);
  });

  it('keeps finished and profile-less accounts out of onboarding entirely', () => {
    for (const step of ['done', 'verify-email', 'no-profile'] as const) {
      expect(canVisitOnboardingPath(step, '/onboarding/plan')).toBe(false);
      expect(canVisitOnboardingPath(step, '/onboarding/verify-identity')).toBe(false);
    }
  });
});
