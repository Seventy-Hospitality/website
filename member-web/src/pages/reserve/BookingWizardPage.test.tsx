import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  api,
  ApiError,
  type CreateReservationResult,
  type Reservation,
  type ReservationQuote,
  type ResourceTypeSummary,
} from '../../lib/api';
import { todayDateKey } from '../../lib/booking';
import { ToastProvider } from '../../components';
import { BookingWizardPage } from './BookingWizardPage';

/**
 * Wizard-level regression tests for the checkout hold lifecycle: the
 * create request outlives the checkout step, responses can land out of
 * order, and a hold with a submitted payment must never be cancelled by
 * the wizard chrome.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getResourceTypes: vi.fn(),
      getMyMembership: vi.fn(),
      getAvailability: vi.fn(),
      getMyClubs: vi.fn(),
      getClubMembers: vi.fn(),
      searchMembers: vi.fn(),
      quoteReservation: vi.fn(),
      createReservation: vi.fn(),
      confirmReservation: vi.fn(),
      getReservation: vi.fn(),
      cancelReservation: vi.fn(),
      addReservationParticipants: vi.fn(),
    },
  };
});

vi.mock('../../lib/session-context', () => ({
  useSession: () => ({ memberId: 'm-self' }),
}));

// CheckoutStep only checks getStripe() for null (a promise is truthy).
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

const getResourceTypes = vi.mocked(api.getResourceTypes);
const getMyMembership = vi.mocked(api.getMyMembership);
const getAvailability = vi.mocked(api.getAvailability);
const getMyClubs = vi.mocked(api.getMyClubs);
const quoteReservation = vi.mocked(api.quoteReservation);
const createReservation = vi.mocked(api.createReservation);
const confirmReservation = vi.mocked(api.confirmReservation);
const cancelReservation = vi.mocked(api.cancelReservation);

const TYPE: ResourceTypeSummary = {
  code: 'badminton_court',
  name: 'Badminton Court',
  slotDurationMinutes: 30,
  opStartMinutes: 480,
  opEndMinutes: 1440,
  hourlyRateCents: 6000,
  maxAdvanceDays: 14,
  minTier: 'member',
  locked: false,
  resourceCount: 4,
  icon: 'badminton_court',
};

const QUOTE: ReservationQuote = {
  typeCode: 'badminton_court',
  date: todayDateKey(),
  slots: ['21:30'],
  durationMinutes: 30,
  hourlyRateCents: 6000,
  totalCents: 3000,
};

const RESERVATION: Reservation = {
  id: 'res1',
  reference: 'BK-010492',
  typeCode: 'badminton_court',
  typeName: 'Badminton Court',
  resource: { id: 'r1', name: 'Court 1' },
  date: todayDateKey(),
  startTime: '21:30',
  endTime: '22:00',
  startsAt: '2026-07-07T01:30:00.000Z',
  endsAt: '2026-07-07T02:00:00.000Z',
  durationMinutes: 30,
  status: 'pending_payment',
  hourlyRateCents: 6000,
  amountPaidCents: 0,
  clubId: null,
  seriesId: null,
  weekly: false,
  createdByAdmin: false,
  participants: [
    {
      memberId: 'm-self',
      firstName: 'Olivia',
      lastName: 'Zha',
      role: 'organizer',
      status: 'confirmed',
      invitedById: null,
    },
  ],
  pendingChange: null,
};

function heldResult(id: string): CreateReservationResult {
  return {
    reservation: { ...RESERVATION, id },
    totalCents: 3000,
    clientSecret: `cs_${id}`,
    holdExpiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
  };
}

function renderWizard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/reserve/badminton_court']}>
          <Routes>
            <Route path="/reserve" element={<div>Reserve home</div>} />
            <Route path="/reserve/:typeCode" element={<BookingWizardPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Select the one slot, then walk Continue -> Continue into checkout. */
async function goToCheckout() {
  await userEvent.click(await screen.findByRole('option', { name: '9:30PM - 10:00PM' }));
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Invite players' });
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Checkout' });
}

beforeEach(() => {
  vi.clearAllMocks();
  getResourceTypes.mockResolvedValue([TYPE]);
  getMyMembership.mockResolvedValue({
    membership: {
      id: 'sub1',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancelAtPeriodEnd: false,
      plan: null,
      pendingPlan: null,
      pendingPlanEffectiveAt: null,
    },
  });
  getAvailability.mockResolvedValue([
    { date: todayDateKey(), slots: [{ start: '21:30', startsAt: new Date().toISOString() }] },
  ]);
  getMyClubs.mockResolvedValue([]);
  quoteReservation.mockResolvedValue(QUOTE);
  createReservation.mockResolvedValue(heldResult('res1'));
  cancelReservation.mockResolvedValue({ cancelled: true, refundCents: 0 });
});

describe('BookingWizardPage hold lifecycle', () => {
  it('cancels an orphaned late-resolving hold, never the live one', async () => {
    let resolveOrphan!: (value: CreateReservationResult) => void;
    createReservation
      .mockImplementationOnce(
        () =>
          new Promise<CreateReservationResult>((resolve) => {
            resolveOrphan = resolve;
          }),
      )
      .mockResolvedValueOnce(heldResult('res-live'));

    renderWizard();
    await goToCheckout();
    await waitFor(() => expect(createReservation).toHaveBeenCalledTimes(1));

    // Back out while create A is still in flight, then re-enter checkout.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Invite players' });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Create B resolves first and is adopted (the court is revealed).
    expect(await screen.findByText('Court 1')).toBeInTheDocument();
    expect(createReservation).toHaveBeenCalledTimes(2);

    // The orphaned create resolves LAST: it must cancel ITS hold, not the
    // live one the payment form is bound to.
    await act(async () => {
      resolveOrphan(heldResult('res-orphan'));
    });
    await waitFor(() => expect(cancelReservation).toHaveBeenCalledWith('res-orphan'));
    expect(cancelReservation).not.toHaveBeenCalledWith('res-live');
    expect(screen.getByText('Court 1')).toBeInTheDocument();
  });

  it('cancels the hold when the wizard unmounts while the create is in flight', async () => {
    let resolveCreate!: (value: CreateReservationResult) => void;
    createReservation.mockImplementationOnce(
      () =>
        new Promise<CreateReservationResult>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const { unmount } = renderWizard();
    await goToCheckout();
    await waitFor(() => expect(createReservation).toHaveBeenCalledTimes(1));

    // Browser back / tab close while the hold request is in flight: the
    // hold that lands afterwards has no owner and must release itself.
    unmount();
    await act(async () => {
      resolveCreate(heldResult('res-late'));
    });
    await waitFor(() => expect(cancelReservation).toHaveBeenCalledWith('res-late'));
  });

  it('disables Back/Close and never cancels once a payment may have captured', async () => {
    confirmPayment.mockResolvedValue({});
    confirmReservation.mockRejectedValue(new ApiError('UNKNOWN', 'boom', 500));

    renderWizard();
    await goToCheckout();
    await userEvent.click(await screen.findByRole('button', { name: /Confirm & pay/ }));

    // The charge went through but confirm needs a retry: the chrome must
    // not offer an exit that would cancel (and forfeit) the paid hold.
    expect(await screen.findByText(/we could not confirm your booking/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close booking' })).toBeDisabled();
    expect(cancelReservation).not.toHaveBeenCalled();
  });

  it('re-enables the chrome after a definitive decline; Back then releases the hold', async () => {
    confirmPayment.mockResolvedValue({
      error: { type: 'card_error', message: 'Your card was declined.' },
    });

    renderWizard();
    await goToCheckout();
    await userEvent.click(await screen.findByRole('button', { name: /Confirm & pay/ }));
    await screen.findByText('Your card was declined.');

    // Nothing captured: backing out is allowed again and releases the
    // (unpaid) hold as usual.
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toBeEnabled();
    await userEvent.click(back);
    await waitFor(() => expect(cancelReservation).toHaveBeenCalledWith('res1'));
    expect(await screen.findByRole('heading', { name: 'Invite players' })).toBeInTheDocument();
  });
});
