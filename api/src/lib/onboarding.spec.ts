import { membershipEverLive, resolveOnboardingNextStep, type OnboardingFacts } from './onboarding';

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    emailVerified: true,
    hasMemberProfile: true,
    membershipStatus: null,
    idVerificationStatus: 'not_submitted',
    idVerificationSkipped: false,
    ...overrides,
  };
}

describe('resolveOnboardingNextStep', () => {
  it('sends a claim-pending signup (no profile, unverified) to verify-email', () => {
    expect(
      resolveOnboardingNextStep(facts({ hasMemberProfile: false, emailVerified: false })),
    ).toBe('verify-email');
  });

  it('flags a verified account with no profile as no-profile (broken state)', () => {
    expect(resolveOnboardingNextStep(facts({ hasMemberProfile: false }))).toBe('no-profile');
  });

  it('sends a member with no membership to plan', () => {
    expect(resolveOnboardingNextStep(facts())).toBe('plan');
  });

  it('treats an incomplete_expired purchase as never started (plan)', () => {
    expect(resolveOnboardingNextStep(facts({ membershipStatus: 'incomplete_expired' }))).toBe('plan');
  });

  it('resumes an unpaid subscription at checkout', () => {
    expect(resolveOnboardingNextStep(facts({ membershipStatus: 'incomplete' }))).toBe('checkout');
  });

  it('does not gate the purchase steps on email verification once a profile exists', () => {
    expect(resolveOnboardingNextStep(facts({ emailVerified: false }))).toBe('plan');
  });

  it('gates a paid member on the unanswered ID step', () => {
    expect(resolveOnboardingNextStep(facts({ membershipStatus: 'active' }))).toBe('identity');
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'] as const)(
    'counts an ever-live membership (%s) as past the purchase steps',
    (status) => {
      const step = resolveOnboardingNextStep(facts({ membershipStatus: status }));
      expect(['identity', 'done']).toContain(step);
    },
  );

  it.each(['submitted', 'verified', 'rejected'] as const)(
    'treats an answered ID step (%s) as done',
    (idStatus) => {
      expect(
        resolveOnboardingNextStep(facts({ membershipStatus: 'active', idVerificationStatus: idStatus })),
      ).toBe('done');
    },
  );

  it('treats a recorded skip as an answered ID step', () => {
    expect(
      resolveOnboardingNextStep(
        facts({ membershipStatus: 'active', idVerificationSkipped: true }),
      ),
    ).toBe('done');
  });
});

describe('membershipEverLive', () => {
  it('is false without a membership or before payment', () => {
    expect(membershipEverLive(null)).toBe(false);
    expect(membershipEverLive('incomplete')).toBe(false);
    expect(membershipEverLive('incomplete_expired')).toBe(false);
  });

  it('is true for every post-payment status', () => {
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled']) {
      expect(membershipEverLive(status)).toBe(true);
    }
  });
});
