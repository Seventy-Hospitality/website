import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type MembershipSummary, type Plan, type Principal } from '../../lib/api';
import { TERMS_VERSION } from '../../lib/onboarding';
import { SessionProvider } from '../../lib/session';
import { billingOverview } from '../../test/billing-overview';
import { CheckoutPage } from './CheckoutPage';

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getMe: vi.fn(),
      getPlans: vi.fn(),
      getMyMembership: vi.fn(),
      subscribeMembership: vi.fn(),
      confirmMembership: vi.fn(),
    },
  };
});

// Checkout only checks getStripe() for null (a promise is truthy); the
// Elements tree it would feed is mocked below.
vi.mock('../../lib/stripe', () => ({
  getStripe: () => Promise.resolve(null),
  stripeAppearance: {},
}));

const { confirmPayment } = vi.hoisted(() => ({ confirmPayment: vi.fn() }));

vi.mock('@stripe/react-stripe-js', async () => {
  const { useEffect } = await import('react');
  return {
    Elements: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    PaymentElement: ({ onReady }: { onReady?: () => void }) => {
      useEffect(() => {
        onReady?.();
      }, [onReady]);
      return <div data-testid="payment-element" />;
    },
    useStripe: () => ({ confirmPayment }),
    useElements: () => ({}),
  };
});

const getMe = vi.mocked(api.getMe);
const getPlans = vi.mocked(api.getPlans);
const getMyMembership = vi.mocked(api.getMyMembership);
const subscribeMembership = vi.mocked(api.subscribeMembership);
const confirmMembership = vi.mocked(api.confirmMembership);

const PRINCIPAL: Principal = {
  userId: 'u1',
  email: 'olivia@example.com',
  emailVerified: true,
  staffRole: null,
  memberId: 'm1',
  client: 'member_web',
};

const PLAN: Plan = {
  id: 'monthly',
  name: 'Monthly Membership',
  stripePriceId: 'price_m',
  amountCents: 2500,
  interval: 'month',
  tier: 'member',
  inviteOnly: false,
  features: ['Book badminton courts'],
  sortOrder: 0,
  active: true,
};

const INCOMPLETE: MembershipSummary = {
  id: 'ms1',
  status: 'incomplete',
  currentPeriodEnd: '2026-09-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  plan: {
    id: PLAN.id,
    name: PLAN.name,
    amountCents: PLAN.amountCents,
    interval: PLAN.interval,
    tier: PLAN.tier,
  },
  pendingPlan: null,
  pendingPlanEffectiveAt: null,
};

const ACTIVE: MembershipSummary = { ...INCOMPLETE, status: 'active' };

const FAILURE_NOTICE = 'Your payment was not completed. Please try again.';

function renderCheckout(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/onboarding/checkout" element={<CheckoutPage />} />
            <Route path="/onboarding/verify-identity" element={<div>verify identity step</div>} />
            <Route path="/onboarding/plan" element={<div>plan step</div>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMe.mockResolvedValue(PRINCIPAL);
  getPlans.mockResolvedValue([PLAN]);
  getMyMembership.mockResolvedValue(billingOverview(INCOMPLETE));
  subscribeMembership.mockResolvedValue({
    subscriptionId: 'sub1',
    clientSecret: 'cs_retry',
    customerId: 'cus1',
    ephemeralKeySecret: 'ek1',
  });
});

describe('CheckoutPage redirect return', () => {
  it.each(['failed', 'requires_payment_method'])(
    'returns a %s payment to the form with the failure notice, not the processing hold',
    async (redirectStatus) => {
      confirmMembership.mockResolvedValue({ activated: false, paymentStatus: 'processing', membership: INCOMPLETE });

      renderCheckout(
        `/onboarding/checkout?plan=monthly&redirect_status=${redirectStatus}&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret`,
      );

      // The failure is announced where the user can retry the payment.
      expect(await screen.findByText(FAILURE_NOTICE)).toBeInTheDocument();
      expect(screen.queryByText('Your payment is processing')).not.toBeInTheDocument();
      expect(
        await screen.findByRole('button', { name: 'Confirm membership' }),
      ).toBeInTheDocument();
      // The form remounted on a fresh secret for the same incomplete purchase.
      expect(subscribeMembership.mock.calls[0]?.[0]).toEqual({
        planId: 'monthly',
        termsVersion: TERMS_VERSION,
      });
    },
  );

  it('holds a successful redirect that has not activated yet as processing', async () => {
    confirmMembership.mockResolvedValue({ activated: false, paymentStatus: 'processing', membership: INCOMPLETE });

    renderCheckout(
      '/onboarding/checkout?plan=monthly&redirect_status=succeeded&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret',
    );

    expect(await screen.findByText('Your payment is processing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.queryByText(FAILURE_NOTICE)).not.toBeInTheDocument();
    // Held: no payment form is mounted, so nothing re-charges.
    expect(subscribeMembership).not.toHaveBeenCalled();
  });

  it('advances to the ID step when the redirect payment activated the membership', async () => {
    confirmMembership.mockResolvedValue({ activated: true, paymentStatus: 'succeeded', membership: ACTIVE });

    renderCheckout(
      '/onboarding/checkout?plan=monthly&redirect_status=succeeded&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret',
    );

    expect(await screen.findByText('verify identity step')).toBeInTheDocument();
  });

  it('lets Check again advance once a held payment clears', async () => {
    confirmMembership
      .mockResolvedValueOnce({ activated: false, paymentStatus: 'processing', membership: INCOMPLETE })
      .mockResolvedValue({ activated: true, paymentStatus: 'succeeded', membership: ACTIVE });

    renderCheckout(
      '/onboarding/checkout?plan=monthly&redirect_status=processing&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret',
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));

    expect(await screen.findByText('verify identity step')).toBeInTheDocument();
  });
});

describe('CheckoutPage inline payment', () => {
  it('enters the processing hold when an async charge succeeds but has not cleared', async () => {
    confirmPayment.mockResolvedValue({});
    confirmMembership.mockResolvedValue({ activated: false, paymentStatus: 'processing', membership: INCOMPLETE });

    renderCheckout('/onboarding/checkout?plan=monthly');

    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm membership' }));

    expect(await screen.findByText('Your payment is processing')).toBeInTheDocument();
    expect(screen.queryByText(FAILURE_NOTICE)).not.toBeInTheDocument();
  });
});
