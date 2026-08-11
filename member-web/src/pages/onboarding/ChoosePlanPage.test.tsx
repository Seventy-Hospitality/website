import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type Plan, type Principal } from '../../lib/api';
import { SessionProvider } from '../../lib/session';
import { ChoosePlanPage } from './ChoosePlanPage';

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getMe: vi.fn(),
      getPlans: vi.fn(),
    },
  };
});

const getMe = vi.mocked(api.getMe);
const getPlans = vi.mocked(api.getPlans);

const PRINCIPAL: Principal = {
  userId: 'u1',
  email: 'olivia@example.com',
  emailVerified: true,
  staffRole: null,
  memberId: 'm1',
  client: 'member_web',
};

const PLANS: Plan[] = [
  {
    id: 'monthly',
    name: 'Monthly Membership',
    stripePriceId: 'price_m',
    amountCents: 2500,
    interval: 'month',
    tier: 'member',
    inviteOnly: false,
    features: ['Book badminton courts', 'Club events'],
    sortOrder: 0,
    active: true,
  },
  {
    id: 'annual',
    name: 'Annual Membership',
    stripePriceId: 'price_a',
    amountCents: 24000,
    interval: 'year',
    tier: 'member',
    inviteOnly: false,
    features: ['Book badminton courts', 'Club events'],
    sortOrder: 1,
    active: true,
  },
  {
    id: 'pro',
    name: 'PRO Membership',
    stripePriceId: 'price_p',
    amountCents: 96000,
    interval: 'year',
    tier: 'pro',
    inviteOnly: true,
    features: ['Priority booking and premium amenities'],
    sortOrder: 2,
    active: true,
  },
];

function CheckoutProbe() {
  const [searchParams] = useSearchParams();
  return <div>checkout for {searchParams.get('plan')}</div>;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <MemoryRouter initialEntries={['/onboarding/plan']}>
          <Routes>
            <Route path="/onboarding/plan" element={<ChoosePlanPage />} />
            <Route path="/onboarding/checkout" element={<CheckoutProbe />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMe.mockResolvedValue(PRINCIPAL);
});

describe('ChoosePlanPage', () => {
  it('defaults to annual pricing with the Member card selected and features listed', async () => {
    getPlans.mockResolvedValue(PLANS);

    renderPage();

    expect(await screen.findByText('$240')).toBeInTheDocument();
    expect(screen.getByText('/ year')).toBeInTheDocument();
    expect(screen.getByText('$20 per month, billed annually.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Pay annually' })).toBeChecked();
    expect(screen.getByRole('button', { name: /^Member/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Book badminton courts')).toBeInTheDocument();
  });

  it('re-prices from the monthly plan row when the toggle changes', async () => {
    getPlans.mockResolvedValue(PLANS);

    renderPage();
    await screen.findByText('$240');

    await userEvent.click(screen.getByRole('radio', { name: 'Pay monthly' }));

    expect(screen.getByText('$25')).toBeInTheDocument();
    expect(screen.getByText('/ month')).toBeInTheDocument();
    expect(screen.getByText('Billed monthly.')).toBeInTheDocument();
  });

  it('renders the invite-only Pro tier locked and unselectable', async () => {
    getPlans.mockResolvedValue(PLANS);

    renderPage();
    await screen.findByText('$240');

    expect(screen.getByText('Invite only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pro/ })).not.toBeInTheDocument();
  });

  it('carries the selected plan row to checkout', async () => {
    getPlans.mockResolvedValue(PLANS);

    renderPage();
    await screen.findByText('$240');

    await userEvent.click(screen.getByRole('radio', { name: 'Pay monthly' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('checkout for monthly')).toBeInTheDocument();
  });

  it('shows a retryable error state when the catalog fails to load', async () => {
    getPlans.mockRejectedValue(new Error('boom'));

    renderPage();

    expect(
      await screen.findByText('We could not load the membership plans.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows the empty state when no plans are published', async () => {
    getPlans.mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText('Memberships are not available yet')).toBeInTheDocument();
  });
});
