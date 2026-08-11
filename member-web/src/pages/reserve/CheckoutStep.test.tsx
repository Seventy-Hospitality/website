import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type CreateReservationResult,
  type Reservation,
  type ReservationQuote,
  type ResourceTypeSummary,
} from '../../lib/api';
import { EMPTY_INVITE_SELECTION } from '../../lib/invites';
import { CheckoutStep } from './CheckoutStep';

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      quoteReservation: vi.fn(),
      createReservation: vi.fn(),
      confirmReservation: vi.fn(),
      getReservation: vi.fn(),
      cancelReservation: vi.fn(),
    },
  };
});

// CheckoutStep only checks getStripe() for null (a promise is truthy);
// the Elements tree it would feed is mocked below.
const { stripeHandle } = vi.hoisted(() => ({
  stripeHandle: { value: Promise.resolve(null) as Promise<null> | null },
}));

vi.mock('../../lib/stripe', () => ({
  getStripe: () => stripeHandle.value,
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

const quoteReservation = vi.mocked(api.quoteReservation);
const createReservation = vi.mocked(api.createReservation);
const confirmReservation = vi.mocked(api.confirmReservation);

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
  date: '2026-07-06',
  slots: ['21:30', '22:00', '22:30', '23:00'],
  durationMinutes: 120,
  hourlyRateCents: 6000,
  totalCents: 12000,
};

const RESERVATION: Reservation = {
  id: 'res1',
  reference: 'BK-010492',
  typeCode: 'badminton_court',
  typeName: 'Badminton Court',
  resource: { id: 'r1', name: 'Court 1' },
  date: '2026-07-06',
  startTime: '21:30',
  endTime: '23:30',
  startsAt: '2026-07-07T01:30:00.000Z',
  endsAt: '2026-07-07T03:30:00.000Z',
  durationMinutes: 120,
  status: 'pending_payment',
  hourlyRateCents: 6000,
  amountPaidCents: 0,
  clubId: null,
  seriesId: null,
  weekly: false,
  createdByAdmin: false,
  participants: [
    {
      memberId: 'm1',
      firstName: 'Olivia',
      lastName: 'Zha',
      role: 'organizer',
      status: 'confirmed',
      invitedById: null,
    },
  ],
  pendingChange: null,
};

const CONFIRMED: Reservation = { ...RESERVATION, status: 'confirmed', amountPaidCents: 12000 };

function heldResult(overrides: Partial<CreateReservationResult> = {}): CreateReservationResult {
  return {
    reservation: RESERVATION,
    totalCents: 12000,
    clientSecret: 'cs_booking',
    holdExpiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
    ...overrides,
  };
}

function renderCheckout() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const onHoldCreated = vi.fn<(id: string) => void>();
  const onConfirmed = vi.fn<(reservation: Reservation) => void>();
  const onPickAnotherTime = vi.fn<(message: string | null) => void>();

  render(
    <QueryClientProvider client={queryClient}>
      <CheckoutStep
        headingRef={createRef<HTMLHeadingElement>()}
        type={TYPE}
        date="2026-07-06"
        slots={['21:30', '22:00', '22:30', '23:00']}
        invites={EMPTY_INVITE_SELECTION}
        onHoldCreated={onHoldCreated}
        onConfirmed={onConfirmed}
        onPickAnotherTime={onPickAnotherTime}
      />
    </QueryClientProvider>,
  );

  return { onHoldCreated, onConfirmed, onPickAnotherTime };
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeHandle.value = Promise.resolve(null);
  quoteReservation.mockResolvedValue(QUOTE);
  createReservation.mockResolvedValue(heldResult());
});

describe('CheckoutStep hold + pay + confirm', () => {
  it('quotes, holds the slot once, and reveals the assigned court', async () => {
    const { onHoldCreated } = renderCheckout();

    expect(await screen.findByText('Court 1')).toBeInTheDocument();
    expect(screen.getByText('$120.00')).toBeInTheDocument();

    await waitFor(() => expect(onHoldCreated).toHaveBeenCalledWith('res1'));
    expect(createReservation).toHaveBeenCalledTimes(1);
    expect(createReservation.mock.calls[0][0]).toEqual({
      typeCode: 'badminton_court',
      date: '2026-07-06',
      slots: ['21:30', '22:00', '22:30', '23:00'],
      invitees: undefined,
    });
  });

  it('confirms after an inline payment and hands the booking to the wizard', async () => {
    confirmPayment.mockResolvedValue({});
    confirmReservation.mockResolvedValue(CONFIRMED);
    const { onConfirmed } = renderCheckout();

    await userEvent.click(await screen.findByRole('button', { name: /Confirm & pay/ }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(onConfirmed.mock.calls[0][0]).toMatchObject({ id: 'res1', status: 'confirmed' });
    expect(confirmReservation.mock.calls[0][0]).toBe('res1');
  });

  it('keeps a declined payment on the form for a retry on the SAME intent', async () => {
    confirmPayment.mockResolvedValue({
      error: { type: 'card_error', message: 'Your card was declined.' },
    });
    const { onConfirmed } = renderCheckout();

    await userEvent.click(await screen.findByRole('button', { name: /Confirm & pay/ }));

    expect(await screen.findByText('Your card was declined.')).toBeInTheDocument();
    // Still on the form: retry re-runs confirmPayment against the same
    // client secret; no new reservation (and no second hold) is created.
    expect(screen.getByRole('button', { name: /Confirm & pay/ })).toBeInTheDocument();
    expect(createReservation).toHaveBeenCalledTimes(1);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(confirmReservation).not.toHaveBeenCalled();
  });

  it('returns to slot selection when the slot was just taken', async () => {
    createReservation.mockRejectedValue(
      new ApiError('SLOT_UNAVAILABLE', 'Slot unavailable', 409),
    );
    const { onPickAnotherTime } = renderCheckout();

    expect(
      await screen.findByText('That time was just taken by another member. Pick another slot.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pick another time' }));
    expect(onPickAnotherTime).toHaveBeenCalledWith(null);
  });

  it('shows the hold-expired state when confirm answers HOLD_EXPIRED', async () => {
    confirmPayment.mockResolvedValue({});
    confirmReservation.mockRejectedValue(new ApiError('HOLD_EXPIRED', 'Hold expired', 409));
    const { onConfirmed, onPickAnotherTime } = renderCheckout();

    await userEvent.click(await screen.findByRole('button', { name: /Confirm & pay/ }));

    expect(
      await screen.findByText(/hold expired before the payment completed/),
    ).toBeInTheDocument();
    expect(onConfirmed).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Choose a new time' }));
    expect(onPickAnotherTime).toHaveBeenCalledWith(null);
  });

  it('shows the hold-expired state when the countdown lapses before paying', async () => {
    createReservation.mockResolvedValue(
      heldResult({ holdExpiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    renderCheckout();

    expect(
      await screen.findByText(/hold expired before the payment completed/),
    ).toBeInTheDocument();
  });

  it('holds an async payment as processing and confirms on Check again', async () => {
    confirmPayment.mockResolvedValue({});
    confirmReservation
      .mockRejectedValueOnce(new ApiError('PAYMENT_REQUIRED', 'Not captured yet', 402))
      .mockResolvedValue(CONFIRMED);
    const { onConfirmed } = renderCheckout();

    await userEvent.click(await screen.findByRole('button', { name: /Confirm & pay/ }));

    expect(await screen.findByText('Your payment is processing')).toBeInTheDocument();
    expect(onConfirmed).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
  });

  it('surfaces a retryable error when confirm fails after the charge went through', async () => {
    confirmPayment.mockResolvedValue({});
    confirmReservation
      .mockRejectedValueOnce(new ApiError('UNKNOWN', 'boom', 500))
      .mockResolvedValue(CONFIRMED);
    const { onConfirmed } = renderCheckout();

    await userEvent.click(await screen.findByRole('button', { name: /Confirm & pay/ }));

    expect(
      await screen.findByText(/we could not confirm your booking/),
    ).toBeInTheDocument();
    expect(screen.getByText(/you will not be charged twice/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
  });

  it('renders the keyless notice and never holds a slot without Stripe', async () => {
    stripeHandle.value = null;
    renderCheckout();

    expect(await screen.findByText('Payments are not configured')).toBeInTheDocument();
    expect(quoteReservation).not.toHaveBeenCalled();
    expect(createReservation).not.toHaveBeenCalled();
  });
});
