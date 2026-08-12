import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../../lib/api';
import { ToastProvider } from '../../components';
import { PaymentMethodPage } from './PaymentMethodPage';

/**
 * Edit payment method: mints ONE setup intent on entry, confirms the card
 * with stripe.confirmSetup, then promotes the new pm_ id to default via
 * POST /api/me/payment-methods/:id/default (with a retry path when only
 * the set-default half fails). Keyless environments get the standard
 * "payments are not configured" state.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      createPaymentMethodSetupIntent: vi.fn(),
      setDefaultPaymentMethod: vi.fn(),
    },
  };
});

const { confirmSetup, stripeState } = vi.hoisted(() => ({
  confirmSetup: vi.fn(),
  stripeState: { available: true },
}));

vi.mock('../../lib/stripe', () => ({
  getStripe: () => (stripeState.available ? Promise.resolve(null) : null),
  stripeAppearance: {},
}));

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
    useStripe: () => ({ confirmSetup }),
    useElements: () => ({}),
  };
});

const createSetupIntent = vi.mocked(api.createPaymentMethodSetupIntent);
const setDefaultPaymentMethod = vi.mocked(api.setDefaultPaymentMethod);

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/account/payment-method']}>
          <Routes>
            <Route path="/account/payment-method" element={<PaymentMethodPage />} />
            <Route path="/account/billing" element={<div>billing screen</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeState.available = true;
  createSetupIntent.mockResolvedValue({
    clientSecret: 'seti_secret',
    customerId: 'cus_1',
    ephemeralKeySecret: 'ek_1',
  });
});

describe('PaymentMethodPage', () => {
  it('mints one setup intent and mounts the Payment Element on it', async () => {
    renderPage();

    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    expect(createSetupIntent).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: 'Save payment method' }),
    ).toBeInTheDocument();
  });

  it('saves the card and promotes it to default, then returns to billing', async () => {
    confirmSetup.mockResolvedValue({
      setupIntent: { status: 'succeeded', payment_method: 'pm_new' },
    });
    setDefaultPaymentMethod.mockResolvedValue({ default: 'pm_new' });

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Save payment method' }));

    expect(confirmSetup).toHaveBeenCalled();
    await waitFor(() => expect(setDefaultPaymentMethod).toHaveBeenCalledWith('pm_new'));
    expect(await screen.findByText('billing screen')).toBeInTheDocument();
  });

  it('surfaces card errors inline without calling set-default', async () => {
    confirmSetup.mockResolvedValue({
      error: { type: 'card_error', message: 'Your card was declined.' },
    });

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Save payment method' }));

    expect(await screen.findByText('Your card was declined.')).toBeInTheDocument();
    expect(setDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('offers a retry that reuses the saved pm id when only set-default fails', async () => {
    confirmSetup.mockResolvedValue({
      setupIntent: { status: 'succeeded', payment_method: 'pm_new' },
    });
    setDefaultPaymentMethod
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ default: 'pm_new' });

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Save payment method' }));

    expect(
      await screen.findByText(/Your card was saved, but we could not make it your default/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(setDefaultPaymentMethod).toHaveBeenCalledTimes(2));
    expect(setDefaultPaymentMethod).toHaveBeenLastCalledWith('pm_new');
    expect(await screen.findByText('billing screen')).toBeInTheDocument();
  });

  it('shows a retryable error when the setup intent cannot be minted', async () => {
    createSetupIntent.mockRejectedValueOnce(new Error('boom'));

    renderPage();

    expect(await screen.findByText('We could not start the card update.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
  });

  it('keeps building keyless: no publishable key means the configuration notice', async () => {
    stripeState.available = false;

    renderPage();

    expect(await screen.findByText('Payments are not configured')).toBeInTheDocument();
    expect(createSetupIntent).not.toHaveBeenCalled();
  });
});
