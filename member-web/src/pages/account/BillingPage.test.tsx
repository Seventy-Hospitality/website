import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  api,
  type BillingOverview,
  type BillingTransaction,
  type MembershipSummary,
} from '../../lib/api';
import { BillingPage } from './BillingPage';

/**
 * The billing screen: membership card (plan, status line, payment method,
 * Change membership gating) and the month history as accessible
 * disclosures whose transactions load lazily on FIRST expand only.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getMyMembership: vi.fn(),
      getBillingTransactions: vi.fn(),
    },
  };
});

const getMyMembership = vi.mocked(api.getMyMembership);
const getBillingTransactions = vi.mocked(api.getBillingTransactions);

const MEMBERSHIP: MembershipSummary = {
  id: 'sub1',
  status: 'active',
  currentPeriodEnd: '2027-03-12T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  plan: { id: 'monthly', name: 'Member monthly', amountCents: 5000, interval: 'month', tier: 'member' },
  pendingPlan: null,
  pendingPlanEffectiveAt: null,
};

const OVERVIEW: BillingOverview = {
  membership: MEMBERSHIP,
  defaultPaymentMethod: {
    id: 'pm_1',
    brand: 'visa',
    last4: '4242',
    expMonth: 9,
    expYear: 2027,
    isDefault: true,
  },
  paymentMethods: [],
  months: [
    { month: '2026-07', debitCents: 19200, creditCents: 0, netCents: 19200, count: 5 },
    { month: '2026-06', debitCents: 20200, creditCents: 1000, netCents: 19200, count: 6 },
  ],
};

const JULY_ROWS: BillingTransaction[] = [
  {
    id: 't1',
    kind: 'membership_fee',
    direction: 'debit',
    amountCents: 5000,
    taxCents: 0,
    currency: 'usd',
    status: 'succeeded',
    occurredAt: '2026-07-01T12:00:00.000Z',
    description: 'Member monthly membership',
    receiptUrl: 'https://stripe.example/receipt',
    reservationId: null,
  },
  {
    id: 't2',
    kind: 'booking_refund',
    direction: 'credit',
    amountCents: 1800,
    taxCents: 0,
    currency: 'usd',
    status: 'succeeded',
    occurredAt: '2026-07-14T12:00:00.000Z',
    description: 'Refund for booking BK-000123',
    receiptUrl: null,
    reservationId: 'res1',
  },
];

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/account/billing']}>
        <BillingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMyMembership.mockResolvedValue(OVERVIEW);
  getBillingTransactions.mockResolvedValue({ month: '2026-07', transactions: JULY_ROWS });
});

describe('BillingPage membership card', () => {
  it('shows the plan, its renewal line, and the default card', async () => {
    renderPage();

    expect(await screen.findByText('Member monthly')).toBeInTheDocument();
    expect(screen.getByText('$50/mo')).toBeInTheDocument();
    expect(screen.getByText('Renews Mar 12, 2027')).toBeInTheDocument();
    expect(screen.getByText(/4242/)).toBeInTheDocument();
    expect(screen.getByText(/exp 09\/27/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Edit/ })).toHaveAttribute(
      'href',
      '/account/payment-method',
    );
    expect(screen.getByRole('link', { name: /Change membership/ })).toHaveAttribute(
      'href',
      '/account/membership',
    );
  });

  it('handles no membership, no payment method, and empty history', async () => {
    getMyMembership.mockResolvedValue({
      membership: null,
      defaultPaymentMethod: null,
      paymentMethods: [],
      months: [],
    });

    renderPage();

    expect(await screen.findByText('You do not have a membership.')).toBeInTheDocument();
    expect(screen.getByText('No transactions yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Change membership/ })).not.toBeInTheDocument();
  });

  it('offers Add instead of Edit when there is no card on file', async () => {
    getMyMembership.mockResolvedValue({ ...OVERVIEW, defaultPaymentMethod: null });

    renderPage();

    expect(await screen.findByText('No payment method on file')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Add/ })).toHaveAttribute(
      'href',
      '/account/payment-method',
    );
  });

  it('hides Change membership for a canceled membership', async () => {
    getMyMembership.mockResolvedValue({
      ...OVERVIEW,
      membership: { ...MEMBERSHIP, status: 'canceled' },
    });

    renderPage();

    expect(await screen.findByText('Ended Mar 12, 2027')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Change membership/ })).not.toBeInTheDocument();
  });
});

describe('BillingPage history disclosures', () => {
  it('renders the month buckets collapsed without fetching any transactions', async () => {
    renderPage();

    const july = await screen.findByRole('button', { name: /July 2026/ });
    expect(july).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('5 transactions · $192')).toBeInTheDocument();
    expect(screen.getByText('6 transactions · $192')).toBeInTheDocument();
    expect(getBillingTransactions).not.toHaveBeenCalled();
  });

  it('lazy-loads a month on first expand and renders its rows', async () => {
    renderPage();

    const july = await screen.findByRole('button', { name: /July 2026/ });
    await userEvent.click(july);

    expect(july).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Member monthly membership')).toBeInTheDocument();
    expect(screen.getByText('$50.00')).toBeInTheDocument();
    // Credits render as money back.
    expect(screen.getByText('-$18.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Receipt' })).toHaveAttribute(
      'href',
      'https://stripe.example/receipt',
    );
    expect(getBillingTransactions).toHaveBeenCalledTimes(1);
    expect(getBillingTransactions).toHaveBeenCalledWith('2026-07');

    // Collapse hides the region; re-expand reuses the cached rows.
    await userEvent.click(july);
    expect(july).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(july);
    expect(await screen.findByText('Member monthly membership')).toBeInTheDocument();
    expect(getBillingTransactions).toHaveBeenCalledTimes(1);
  });

  it('shows a retryable error inside the month that failed to load', async () => {
    getBillingTransactions.mockRejectedValueOnce(new Error('boom'));

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /July 2026/ }));
    expect(await screen.findByText('We could not load this month.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Member monthly membership')).toBeInTheDocument();
  });
});

describe('BillingPage load states', () => {
  it('shows a retryable error when the overview read fails', async () => {
    getMyMembership.mockRejectedValueOnce(new Error('boom'));

    renderPage();

    expect(await screen.findByText('We could not load your billing.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Member monthly')).toBeInTheDocument();
  });

  it('waits on a skeleton while the overview loads', async () => {
    let resolveOverview!: (value: BillingOverview) => void;
    getMyMembership.mockImplementation(
      () => new Promise<BillingOverview>((resolve) => (resolveOverview = resolve)),
    );

    renderPage();

    expect(screen.getByText('Loading your billing')).toBeInTheDocument();
    resolveOverview(OVERVIEW);
    await waitFor(() => expect(screen.getByText('Member monthly')).toBeInTheDocument());
  });
});
