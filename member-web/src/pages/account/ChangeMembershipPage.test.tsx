import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, type MembershipSummary, type Plan } from '../../lib/api';
import { ToastProvider } from '../../components';
import { billingOverview } from '../../test/billing-overview';
import { ChangeMembershipPage } from './ChangeMembershipPage';

/**
 * The change-membership screen: plan cards from the shared plan-pricing
 * catalog logic, the mirrored proration copy (upgrade now vs downgrade at
 * period end), the change call, the paid-upgrade Payment Element path with
 * the confirm read-back, and the cancel confirm (period end vs now).
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getPlans: vi.fn(),
      getMyMembership: vi.fn(),
      changeMembership: vi.fn(),
      confirmMembership: vi.fn(),
      cancelMembership: vi.fn(),
    },
  };
});

// The page only checks getStripe() for null; the Elements tree is mocked.
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

const getPlans = vi.mocked(api.getPlans);
const getMyMembership = vi.mocked(api.getMyMembership);
const changeMembership = vi.mocked(api.changeMembership);
const confirmMembership = vi.mocked(api.confirmMembership);
const cancelMembership = vi.mocked(api.cancelMembership);

const MONTHLY: Plan = {
  id: 'monthly',
  name: 'Member monthly',
  stripePriceId: 'price_m',
  amountCents: 2500,
  interval: 'month',
  tier: 'member',
  inviteOnly: false,
  features: [],
  sortOrder: 0,
  active: true,
};

const ANNUAL: Plan = {
  ...MONTHLY,
  id: 'annual',
  name: 'Member annual',
  stripePriceId: 'price_y',
  amountCents: 24000,
  interval: 'year',
  sortOrder: 1,
};

function membershipOn(plan: Plan): MembershipSummary {
  return {
    id: 'sub1',
    status: 'active',
    currentPeriodEnd: '2026-09-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    plan: {
      id: plan.id,
      name: plan.name,
      amountCents: plan.amountCents,
      interval: plan.interval,
      tier: plan.tier,
    },
    pendingPlan: null,
    pendingPlanEffectiveAt: null,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/account/membership']}>
          <Routes>
            <Route path="/account/membership" element={<ChangeMembershipPage />} />
            <Route path="/account/billing" element={<div>billing screen</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getPlans.mockResolvedValue([MONTHLY, ANNUAL]);
  getMyMembership.mockResolvedValue(billingOverview(membershipOn(ANNUAL)));
});

describe('ChangeMembershipPage plan cards', () => {
  it("opens on the current plan's billing period with the Current plan badge", async () => {
    renderPage();

    const currentCard = await screen.findByRole('radio', { name: /Member annual/ });
    expect(currentCard).toBeInTheDocument();
    expect(screen.getByText('Current plan')).toBeInTheDocument();
    // The period toggle defaults to the current plan's interval.
    expect(screen.getByRole('radio', { name: 'Pay annually' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('describes a downgrade as starting at period end and schedules it', async () => {
    changeMembership.mockResolvedValue({
      kind: 'downgrade_scheduled',
      clientSecret: null,
      pendingPlanEffectiveAt: '2026-09-01T00:00:00.000Z',
      membership: membershipOn(ANNUAL),
    });

    renderPage();

    // Annual -> monthly is a downgrade (mirrors the backend policy).
    await userEvent.click(await screen.findByRole('radio', { name: 'Pay monthly' }));
    await userEvent.click(await screen.findByRole('radio', { name: /Member monthly/ }));

    expect(screen.getByText(/starts on Sep 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/difference is not refunded/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Switch on Sep 1, 2026' }));

    expect(changeMembership).toHaveBeenCalledWith('monthly');
    expect(await screen.findByText('billing screen')).toBeInTheDocument();
  });

  it('applies an upgrade with nothing to collect immediately', async () => {
    getMyMembership.mockResolvedValue(billingOverview(membershipOn(MONTHLY)));
    changeMembership.mockResolvedValue({
      kind: 'upgraded',
      clientSecret: null,
      pendingPlanEffectiveAt: null,
      membership: membershipOn(ANNUAL),
    });

    renderPage();

    // Monthly -> annual is an upgrade: switch the toggle to find the card.
    await userEvent.click(await screen.findByRole('radio', { name: 'Pay annually' }));
    await userEvent.click(await screen.findByRole('radio', { name: /Member annual/ }));

    expect(screen.getByText(/starts right away/)).toBeInTheDocument();
    expect(screen.getByText(/prorated/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Switch now' }));

    expect(changeMembership).toHaveBeenCalledWith('annual');
    expect(await screen.findByText('billing screen')).toBeInTheDocument();
  });

  it('collects the proration payment when the upgrade returns a client secret', async () => {
    getMyMembership.mockResolvedValue(billingOverview(membershipOn(MONTHLY)));
    changeMembership.mockResolvedValue({
      kind: 'upgraded',
      clientSecret: 'pi_secret',
      pendingPlanEffectiveAt: null,
      membership: membershipOn(ANNUAL),
    });
    confirmPayment.mockResolvedValue({});
    confirmMembership.mockResolvedValue({
      activated: true,
      paymentStatus: 'succeeded',
      membership: membershipOn(ANNUAL),
    });

    renderPage();

    await userEvent.click(await screen.findByRole('radio', { name: 'Pay annually' }));
    await userEvent.click(await screen.findByRole('radio', { name: /Member annual/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Switch now' }));

    // The Payment Element mounts on the proration invoice's secret.
    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pay and switch plan' }));

    expect(confirmPayment).toHaveBeenCalled();
    expect(confirmMembership).toHaveBeenCalled();
    expect(await screen.findByText('billing screen')).toBeInTheDocument();
  });

  it('holds a still-clearing proration payment as processing', async () => {
    getMyMembership.mockResolvedValue(billingOverview(membershipOn(MONTHLY)));
    changeMembership.mockResolvedValue({
      kind: 'upgraded',
      clientSecret: 'pi_secret',
      pendingPlanEffectiveAt: null,
      membership: membershipOn(ANNUAL),
    });
    confirmPayment.mockResolvedValue({});
    confirmMembership.mockResolvedValue({
      activated: false,
      paymentStatus: 'processing',
      membership: membershipOn(MONTHLY),
    });

    renderPage();

    await userEvent.click(await screen.findByRole('radio', { name: 'Pay annually' }));
    await userEvent.click(await screen.findByRole('radio', { name: /Member annual/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Switch now' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Pay and switch plan' }));

    expect(await screen.findByText('Your payment is processing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });
});

describe('ChangeMembershipPage cancel', () => {
  it('cancels at period end by default behind the confirm sheet', async () => {
    cancelMembership.mockResolvedValue({
      canceledImmediately: false,
      effectiveAt: '2026-09-01T00:00:00.000Z',
      membership: { ...membershipOn(ANNUAL), cancelAtPeriodEnd: true },
    });

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel membership' }));
    expect(
      screen.getByText(/stays active until Sep 1, 2026, then ends/),
    ).toBeInTheDocument();
    expect(cancelMembership).not.toHaveBeenCalled();

    // The sheet's footer carries the destructive confirm.
    const confirmButtons = screen.getAllByRole('button', { name: 'Cancel membership' });
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(cancelMembership).toHaveBeenCalledWith({ now: false });
    expect(await screen.findByText('billing screen')).toBeInTheDocument();
  });

  it('cancels immediately only with the explicit opt-in', async () => {
    cancelMembership.mockResolvedValue({
      canceledImmediately: true,
      effectiveAt: '2026-08-12T00:00:00.000Z',
      membership: { ...membershipOn(ANNUAL), status: 'canceled' },
    });

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel membership' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Cancel immediately instead/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel immediately' }));

    expect(cancelMembership).toHaveBeenCalledWith({ now: true });
    expect(await screen.findByText('billing screen')).toBeInTheDocument();
  });
});

describe('ChangeMembershipPage gating', () => {
  it('turns a membership that cannot be changed into an explanatory empty state', async () => {
    getMyMembership.mockResolvedValue(
      billingOverview({ ...membershipOn(ANNUAL), status: 'canceled' }),
    );

    renderPage();

    expect(await screen.findByText('No active membership to change')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Member annual/ })).not.toBeInTheDocument();
  });
});
