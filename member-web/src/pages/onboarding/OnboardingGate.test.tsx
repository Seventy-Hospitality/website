import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type IdVerificationView, type MembershipSummary, type Principal } from '../../lib/api';
import { SessionProvider } from '../../lib/session';
import { billingOverview } from '../../test/billing-overview';
import { OnboardingGate } from './OnboardingGate';

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getMe: vi.fn(),
      getMyMembership: vi.fn(),
      getIdVerification: vi.fn(),
    },
  };
});

const getMe = vi.mocked(api.getMe);
const getMyMembership = vi.mocked(api.getMyMembership);
const getIdVerification = vi.mocked(api.getIdVerification);

const PRINCIPAL: Principal = {
  userId: 'u1',
  email: 'olivia@example.com',
  emailVerified: true,
  staffRole: null,
  memberId: 'm1',
  client: 'member_web',
};

function membership(status: MembershipSummary['status']): MembershipSummary {
  return {
    id: 'ms1',
    status,
    currentPeriodEnd: '2027-01-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    plan: {
      id: 'annual',
      name: 'Annual Membership',
      amountCents: 24000,
      interval: 'year',
      tier: 'member',
    },
    pendingPlan: null,
    pendingPlanEffectiveAt: null,
  };
}

function idView(overrides: Partial<IdVerificationView> = {}): IdVerificationView {
  return {
    status: 'not_submitted',
    hasPhoto: false,
    skippedAt: null,
    submittedAt: null,
    reviewedAt: null,
    note: null,
    ...overrides,
  };
}

function renderAt(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route element={<OnboardingGate />}>
              <Route path="/" element={<div>home screen</div>} />
              <Route path="/onboarding/plan" element={<div>plan screen</div>} />
              <Route path="/onboarding/checkout" element={<div>checkout screen</div>} />
              <Route path="/onboarding/verify-identity" element={<div>identity screen</div>} />
            </Route>
            <Route path="/verify-email" element={<div>verify-email screen</div>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMe.mockResolvedValue(PRINCIPAL);
  getIdVerification.mockResolvedValue(idView());
});

describe('OnboardingGate resume gating', () => {
  it('pushes a member with no membership from home into plan selection', async () => {
    getMyMembership.mockResolvedValue(billingOverview(null));

    renderAt('/');

    expect(await screen.findByText('plan screen')).toBeInTheDocument();
  });

  it('resumes an unpaid purchase at checkout', async () => {
    getMyMembership.mockResolvedValue(billingOverview(membership('incomplete')));

    renderAt('/');

    expect(await screen.findByText('checkout screen')).toBeInTheDocument();
  });

  it('sends a paid member with an unanswered ID step to the identity modal', async () => {
    getMyMembership.mockResolvedValue(billingOverview(membership('active')));

    renderAt('/');

    expect(await screen.findByText('identity screen')).toBeInTheDocument();
  });

  it('keeps a paid member out of the purchase steps', async () => {
    getMyMembership.mockResolvedValue(billingOverview(membership('active')));

    renderAt('/onboarding/plan');

    expect(await screen.findByText('identity screen')).toBeInTheDocument();
  });

  it('lets a fully onboarded member (ID skipped) into the app and out of onboarding', async () => {
    getMyMembership.mockResolvedValue(billingOverview(membership('active')));
    getIdVerification.mockResolvedValue(idView({ skippedAt: '2026-08-11T00:00:00.000Z' }));

    renderAt('/onboarding/plan');

    expect(await screen.findByText('home screen')).toBeInTheDocument();
  });

  it('does not force a lapsed (canceled) member back into onboarding', async () => {
    getMyMembership.mockResolvedValue(billingOverview(membership('canceled')));
    getIdVerification.mockResolvedValue(idView({ status: 'verified' }));

    renderAt('/');

    expect(await screen.findByText('home screen')).toBeInTheDocument();
  });

  it('sends a claim-pending account (no profile) to the email verification prompt', async () => {
    getMe.mockResolvedValue({ ...PRINCIPAL, memberId: null, emailVerified: false });

    renderAt('/');

    expect(await screen.findByText('verify-email screen')).toBeInTheDocument();
    expect(getMyMembership).not.toHaveBeenCalled();
  });

  it('shows the support state for a verified account with no profile instead of looping', async () => {
    getMe.mockResolvedValue({ ...PRINCIPAL, memberId: null, emailVerified: true });

    renderAt('/');

    expect(
      await screen.findByText('We could not find your member profile'),
    ).toBeInTheDocument();
  });

  it('surfaces a retryable error when the membership read fails', async () => {
    getMyMembership.mockRejectedValue(new Error('boom'));

    renderAt('/');

    expect(await screen.findByText('We could not load your membership')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
