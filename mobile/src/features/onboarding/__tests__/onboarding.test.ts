import type { IdVerificationStatus, MembershipStatus } from '../../../lib/api';
import {
  canVisitOnboardingPath,
  onboardingPathForStep,
  resolveOnboardingStep,
  type OnboardingStateInput,
} from '../onboarding';

function state(overrides: Partial<OnboardingStateInput> = {}): OnboardingStateInput {
  return {
    emailVerified: true,
    memberId: 'm1',
    membership: null,
    idVerification: { status: 'not_submitted', skippedAt: null },
    ...overrides,
  };
}

function membership(status: MembershipStatus) {
  return { status };
}

function idView(status: IdVerificationStatus, skippedAt: string | null = null) {
  return { status, skippedAt };
}

describe('resolveOnboardingStep', () => {
  it('sends a claim-pending account (no profile, unverified email) to verify-email', () => {
    expect(resolveOnboardingStep(state({ memberId: null, emailVerified: false }))).toBe(
      'verify-email',
    );
  });

  it('surfaces the no-profile support state for a verified account without a profile', () => {
    expect(resolveOnboardingStep(state({ memberId: null, emailVerified: true }))).toBe(
      'no-profile',
    );
  });

  it('pushes a member with no membership into plan selection', () => {
    expect(resolveOnboardingStep(state({ membership: null }))).toBe('plan');
  });

  it('treats an expired incomplete attempt as needing a fresh plan', () => {
    expect(resolveOnboardingStep(state({ membership: membership('incomplete_expired') }))).toBe(
      'plan',
    );
  });

  it('resumes an unpaid (incomplete) subscription at checkout', () => {
    expect(resolveOnboardingStep(state({ membership: membership('incomplete') }))).toBe('checkout');
  });

  it('sends a paid member with an unanswered ID step to identity', () => {
    expect(
      resolveOnboardingStep({
        ...state({ membership: membership('active') }),
        idVerification: idView('not_submitted', null),
      }),
    ).toBe('identity');
  });

  it('fails closed to identity when the ID read is absent', () => {
    expect(
      resolveOnboardingStep({ ...state({ membership: membership('active') }), idVerification: null }),
    ).toBe('identity');
  });

  it('treats a submitted ID as answered (done)', () => {
    expect(
      resolveOnboardingStep({
        ...state({ membership: membership('active') }),
        idVerification: idView('submitted'),
      }),
    ).toBe('done');
  });

  it('treats a recorded skip as answered (done)', () => {
    expect(
      resolveOnboardingStep({
        ...state({ membership: membership('active') }),
        idVerification: idView('not_submitted', '2026-08-11T00:00:00.000Z'),
      }),
    ).toBe('done');
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'] as MembershipStatus[])(
    'does not force a member with an ever-live membership (%s) back into the purchase steps',
    (status) => {
      expect(
        resolveOnboardingStep({
          ...state({ membership: membership(status) }),
          idVerification: idView('verified'),
        }),
      ).toBe('done');
    },
  );
});

describe('onboardingPathForStep', () => {
  it('maps each step to its native route', () => {
    expect(onboardingPathForStep('verify-email')).toBe('/onboarding/verify-email');
    expect(onboardingPathForStep('plan')).toBe('/onboarding/plan');
    expect(onboardingPathForStep('checkout')).toBe('/onboarding/checkout');
    expect(onboardingPathForStep('identity')).toBe('/onboarding/verify-identity');
    expect(onboardingPathForStep('done')).toBe('/(tabs)');
    expect(onboardingPathForStep('no-profile')).toBe('/(tabs)');
  });
});

describe('canVisitOnboardingPath', () => {
  it('lets plan and checkout reach either purchase route', () => {
    expect(canVisitOnboardingPath('plan', '/onboarding/plan')).toBe(true);
    expect(canVisitOnboardingPath('plan', '/onboarding/checkout')).toBe(true);
    expect(canVisitOnboardingPath('checkout', '/onboarding/plan')).toBe(true);
    expect(canVisitOnboardingPath('checkout', '/onboarding/verify-identity')).toBe(false);
  });

  it('confines the identity step to the verify-identity route', () => {
    expect(canVisitOnboardingPath('identity', '/onboarding/verify-identity')).toBe(true);
    expect(canVisitOnboardingPath('identity', '/onboarding/plan')).toBe(false);
  });

  it('confines verify-email to its own route', () => {
    expect(canVisitOnboardingPath('verify-email', '/onboarding/verify-email')).toBe(true);
    expect(canVisitOnboardingPath('verify-email', '/onboarding/plan')).toBe(false);
  });

  it('lets no onboarding route host a done member', () => {
    expect(canVisitOnboardingPath('done', '/onboarding/plan')).toBe(false);
    expect(canVisitOnboardingPath('no-profile', '/onboarding/verify-identity')).toBe(false);
  });
});
