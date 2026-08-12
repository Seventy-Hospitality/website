import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError } from '../../../lib/api';
import type {
  CreateReservationResult,
  Reservation,
  ReservationQuote,
  ResourceTypeSummary,
} from '../../../lib/api';
import type { PresentPaymentResult } from '../../../lib/stripe';
import { CheckoutStep } from '../CheckoutStep';
import { EMPTY_INVITE_SELECTION } from '../invites';

// Native payment surface: configured, with a controllable PaymentSheet result.
// (mock-prefixed so jest.mock's hoisted factory may reference them.)
let mockSheetResult: PresentPaymentResult;
const mockPresentPayment = jest.fn(async (): Promise<PresentPaymentResult> => mockSheetResult);
jest.mock('../../../lib/stripe', () => ({
  usePaymentsConfigured: () => true,
  usePaymentSheet: () => mockPresentPayment,
}));

// Freeze the hold countdown so it never auto-expires mid-test (no timers).
jest.mock('../useCountdown', () => ({ useCountdown: () => 600 }));

const TYPE: ResourceTypeSummary = {
  code: 'badminton_court',
  name: 'Badminton Court',
  slotDurationMinutes: 30,
  opStartMinutes: 6 * 60,
  opEndMinutes: 22 * 60,
  hourlyRateCents: 3000,
  maxAdvanceDays: 14,
  minTier: 'member',
  locked: false,
  resourceCount: 4,
  icon: 'tennisball-outline',
};

const QUOTE: ReservationQuote = {
  typeCode: 'badminton_court',
  date: '2026-08-20',
  slots: ['20:00', '20:30'],
  durationMinutes: 60,
  hourlyRateCents: 3000,
  totalCents: 6000,
};

const RESERVATION: Reservation = {
  id: 'res_1',
  reference: 'BAD-001',
  typeCode: 'badminton_court',
  typeName: 'Badminton Court',
  resource: { id: 'court_2', name: 'Court 2' },
  date: '2026-08-20',
  startTime: '20:00',
  endTime: '21:00',
  startsAt: '2026-08-20T20:00:00.000Z',
  endsAt: '2026-08-20T21:00:00.000Z',
  durationMinutes: 60,
  status: 'pending_payment',
  hourlyRateCents: 3000,
  amountPaidCents: 0,
  clubId: null,
  seriesId: null,
  weekly: false,
  createdByAdmin: false,
  participants: [],
  pendingChange: null,
};

const HELD: CreateReservationResult = {
  reservation: RESERVATION,
  totalCents: 6000,
  clientSecret: 'pi_original_secret',
  holdExpiresAt: '2026-08-20T19:12:00.000Z',
};

function renderCheckout(onPaymentLock: (locked: boolean) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <CheckoutStep
      type={TYPE}
      date="2026-08-20"
      slots={['20:00', '20:30']}
      invites={EMPTY_INVITE_SELECTION}
      beginHoldAttempt={() => 1}
      onHoldCreated={jest.fn()}
      onPaymentLock={onPaymentLock}
      onConfirmed={jest.fn()}
      onPickAnotherTime={jest.fn()}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockPresentPayment.mockClear();
  jest.spyOn(api, 'quoteReservation').mockResolvedValue(QUOTE);
  jest.spyOn(api, 'createReservation').mockResolvedValue(HELD);
});

async function reachPayableCheckout() {
  const button = await screen.findByLabelText(/Confirm & pay/);
  return button;
}

describe('CheckoutStep money-lock wiring (reissue after a failed PaymentSheet)', () => {
  it('NEVER clears the lock on an indeterminate reissue failure (network / 5xx)', async () => {
    // The failed-then-network-drop sequence from the finding: a captured
    // charge may be in flight, so the lock must stay on.
    mockSheetResult = { status: 'failed', message: 'Card was declined.' };
    const reissue = jest
      .spyOn(api, 'reissuePaymentIntent')
      .mockRejectedValue(new TypeError('Network request failed'));
    const onPaymentLock = jest.fn();

    renderCheckout(onPaymentLock);
    fireEvent.press(await reachPayableCheckout());

    // The recover takeover is shown and the lock was never released.
    await screen.findByText("We couldn't finish your payment");
    expect(reissue).toHaveBeenCalledWith('res_1');
    expect(onPaymentLock).toHaveBeenCalledWith(true);
    expect(onPaymentLock).not.toHaveBeenCalledWith(false);
  });

  it('keeps the lock on a terminal (gone) hold and routes to hold-expired', async () => {
    mockSheetResult = { status: 'failed', message: 'Card was declined.' };
    jest
      .spyOn(api, 'reissuePaymentIntent')
      .mockRejectedValue(new ApiError('HOLD_EXPIRED', 'hold expired', 409));
    const onPaymentLock = jest.fn();

    renderCheckout(onPaymentLock);
    fireEvent.press(await reachPayableCheckout());

    await screen.findByText(/hold expired before the payment completed/i);
    expect(onPaymentLock).toHaveBeenCalledWith(true);
    expect(onPaymentLock).not.toHaveBeenCalledWith(false);
  });

  it('clears the lock ONLY when a fresh secret is minted (proven-unpaid retry)', async () => {
    mockSheetResult = { status: 'failed', message: 'Card was declined.' };
    jest.spyOn(api, 'reissuePaymentIntent').mockResolvedValue({
      reservation: RESERVATION,
      purpose: 'hold',
      amountCents: 6000,
      clientSecret: 'pi_fresh_secret',
      expiresAt: '2026-08-20T19:24:00.000Z',
      alreadyPaid: false,
    });
    const onPaymentLock = jest.fn();

    renderCheckout(onPaymentLock);
    fireEvent.press(await reachPayableCheckout());

    await waitFor(() => expect(onPaymentLock).toHaveBeenCalledWith(false));
    expect(onPaymentLock).toHaveBeenCalledWith(true);
    // Back on the payable checkout with a retry prompt (not the recover takeover).
    expect(screen.queryByText("We couldn't finish your payment")).toBeNull();
    await screen.findByLabelText(/Confirm & pay/);
  });

  it('settles a captured charge without unlocking (alreadyPaid)', async () => {
    mockSheetResult = { status: 'failed', message: 'Card was declined.' };
    jest.spyOn(api, 'reissuePaymentIntent').mockResolvedValue({
      reservation: RESERVATION,
      purpose: 'hold',
      amountCents: 6000,
      clientSecret: null,
      expiresAt: null,
      alreadyPaid: true,
    });
    const confirmSpy = jest.spyOn(api, 'confirmReservation').mockResolvedValue(RESERVATION);
    const onPaymentLock = jest.fn();
    const onConfirmed = jest.fn();

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CheckoutStep
          type={TYPE}
          date="2026-08-20"
          slots={['20:00', '20:30']}
          invites={EMPTY_INVITE_SELECTION}
          beginHoldAttempt={() => 1}
          onHoldCreated={jest.fn()}
          onPaymentLock={onPaymentLock}
          onConfirmed={onConfirmed}
          onPickAnotherTime={jest.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.press(await screen.findByLabelText(/Confirm & pay/));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0][0]).toBe('res_1');
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    // The lock is held through settle; it is never released on this path.
    expect(onPaymentLock).not.toHaveBeenCalledWith(false);
  });
});
