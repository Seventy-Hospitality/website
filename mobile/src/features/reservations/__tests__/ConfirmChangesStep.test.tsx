import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  api,
  type Reservation,
  type ReservationViewer,
  type ResourceTypeSummary,
  type RescheduleQuote,
  type RescheduleResult,
} from '../../../lib/api';
import type { PresentPaymentResult } from '../../../lib/stripe';
import { createHoldSession } from '../../reserve/hold-session';
import { ConfirmChangesStep } from '../ConfirmChangesStep';

// Native payment surface: configured, with a controllable PaymentSheet result.
let mockSheetResult: PresentPaymentResult;
const mockPresentPayment = jest.fn(async (): Promise<PresentPaymentResult> => mockSheetResult);
jest.mock('../../../lib/stripe', () => ({
  usePaymentsConfigured: () => true,
  usePaymentSheet: () => mockPresentPayment,
}));

// Freeze the change countdown so it never auto-expires mid-test (no timers).
jest.mock('../../reserve/useCountdown', () => ({ useCountdown: () => 600 }));

const VIEWER: ReservationViewer = {
  role: 'organizer',
  status: 'confirmed',
  canInvite: true,
  canManage: true,
  canRespond: false,
};

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
  icon: 'badminton_court',
};

const DETAIL: Reservation & { viewer: ReservationViewer } = {
  id: 'r1',
  reference: 'BK-010492',
  typeCode: 'badminton_court',
  typeName: 'Badminton Court',
  resource: { id: 'court_1', name: 'Court 1' },
  date: '2026-08-20',
  startTime: '20:00',
  endTime: '21:00',
  startsAt: '2026-08-20T20:00:00.000Z',
  endsAt: '2026-08-20T21:00:00.000Z',
  durationMinutes: 60,
  status: 'confirmed',
  hourlyRateCents: 3000,
  amountPaidCents: 6000,
  clubId: null,
  seriesId: null,
  weekly: false,
  createdByAdmin: false,
  participants: [
    { memberId: 'org', firstName: 'Olivia', lastName: 'Zha', role: 'organizer', status: 'confirmed', invitedById: null },
  ],
  pendingChange: null,
  viewer: VIEWER,
};

function renderStep(date: string, slots: string[], onApplied = jest.fn(), onLockChange = jest.fn()) {
  const holdSession = createHoldSession({ cancel: jest.fn(), onLockChange });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const onBackToTime = jest.fn();
  const view = render(
    <ConfirmChangesStep
      detail={DETAIL}
      type={TYPE}
      date={date}
      slots={slots}
      holdSession={holdSession}
      onApplied={onApplied}
      onBackToTime={onBackToTime}
    />,
    { wrapper },
  );
  return { view, onApplied, onLockChange, onBackToTime };
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockPresentPayment.mockClear();
});

describe('ConfirmChangesStep — shrink/refund branch (applies immediately)', () => {
  it('shows the refund copy, never parks/pays, and PATCHes on Save', async () => {
    const quote: RescheduleQuote = {
      date: '2026-08-20',
      slots: ['20:00'],
      durationMinutes: 30,
      newTotalCents: 1500,
      netPaidCents: 6000,
      deltaCents: -1500,
    };
    jest.spyOn(api, 'rescheduleQuote').mockResolvedValue(quote);
    const patch = jest.spyOn(api, 'rescheduleReservation').mockResolvedValue({
      reservation: { ...DETAIL, startTime: '20:00', endTime: '20:30', durationMinutes: 30, amountPaidCents: 4500 },
      deltaCents: -1500,
      clientSecret: null,
    } as RescheduleResult);

    const { onApplied } = renderStep('2026-08-20', ['20:00']);

    await screen.findByText(/refunded to the card you paid with/i);
    // No PaymentSheet, and no PATCH until Save is pressed.
    expect(mockPresentPayment).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('Save changes'));

    await waitFor(() => expect(patch).toHaveBeenCalledWith('r1', { date: '2026-08-20', slots: ['20:00'] }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onApplied.mock.calls[0][1]).toEqual(expect.objectContaining({ kind: 'refund', refundCents: 1500 }));
  });
});

describe('ConfirmChangesStep — grow/charge branch (collects the delta first)', () => {
  const growQuote: RescheduleQuote = {
    date: '2026-08-20',
    slots: ['20:00', '20:30', '21:00'],
    durationMinutes: 90,
    newTotalCents: 9000,
    netPaidCents: 6000,
    deltaCents: 3000,
  };

  const parked: RescheduleResult = {
    reservation: {
      ...DETAIL,
      pendingChange: {
        date: '2026-08-20',
        startTime: '20:00',
        endTime: '21:30',
        deltaCents: 3000,
        expiresAt: '2026-08-20T19:30:00.000Z',
      },
    },
    deltaCents: 3000,
    clientSecret: 'pi_delta_secret',
  };

  it('auto-parks the change and, on a completed sheet + matching confirm, applies it', async () => {
    jest.spyOn(api, 'rescheduleQuote').mockResolvedValue(growQuote);
    const patch = jest.spyOn(api, 'rescheduleReservation').mockResolvedValue(parked);
    const confirm = jest.spyOn(api, 'confirmReservation').mockResolvedValue({
      ...DETAIL,
      startTime: '20:00',
      endTime: '21:30',
      durationMinutes: 90,
      amountPaidCents: 9000,
      pendingChange: null,
    });
    mockSheetResult = { status: 'completed' };

    const { onApplied, onLockChange } = renderStep('2026-08-20', ['20:00', '20:30', '21:00']);

    // The grow parks the change up front (mirrors checkout holding on entry).
    await waitFor(() => expect(patch).toHaveBeenCalledWith('r1', { date: '2026-08-20', slots: ['20:00', '20:30', '21:00'] }));
    const pay = await screen.findByText(/Save changes/);

    fireEvent.press(pay);

    await waitFor(() => expect(mockPresentPayment).toHaveBeenCalledWith({ clientSecret: 'pi_delta_secret' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onApplied.mock.calls[0][1]).toEqual(expect.objectContaining({ kind: 'charge', dueTodayCents: 3000 }));
    // The payment lock was engaged for the charge.
    expect(onLockChange).toHaveBeenCalledWith(true);
  });

  it('keeps the payment lock ON when a failed sheet + reissue is indeterminate (money-safety)', async () => {
    jest.spyOn(api, 'rescheduleQuote').mockResolvedValue(growQuote);
    jest.spyOn(api, 'rescheduleReservation').mockResolvedValue(parked);
    const reissue = jest
      .spyOn(api, 'reissuePaymentIntent')
      .mockRejectedValue(new TypeError('Network request failed'));
    mockSheetResult = { status: 'failed', message: 'Card was declined.' };

    const { onLockChange } = renderStep('2026-08-20', ['20:00', '20:30', '21:00']);

    const pay = await screen.findByText(/Save changes/);
    fireEvent.press(pay);

    await screen.findByText("We couldn't finish your payment");
    expect(reissue).toHaveBeenCalledWith('r1');
    // Locked for the attempt, and NEVER released on the indeterminate outcome.
    expect(onLockChange).toHaveBeenCalledWith(true);
    expect(onLockChange).not.toHaveBeenCalledWith(false);
  });
});
