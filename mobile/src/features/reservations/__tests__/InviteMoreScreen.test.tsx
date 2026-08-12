import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, ApiError, type Reservation, type ReservationViewer } from '../../../lib/api';
import { ToastProvider } from '../../../components';
import { InviteMoreScreen } from '../InviteMoreScreen';

jest.mock('../../../lib/session', () => ({
  useSession: () => ({ memberId: 'org' }),
}));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn(), canGoBack: () => true }),
}));

// The invite step pulls in member-search / club queries that are irrelevant to
// the load-error branches under test; stub it so the gate logic is isolated.
jest.mock('../../reserve/InvitePlayersStep', () => ({
  InvitePlayersStep: () => {
    const { Text: RNText } = require('react-native');
    return <RNText>invite-step-ready</RNText>;
  },
}));

const FAR_FUTURE = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

function makeReservation(viewer: ReservationViewer): Reservation & { viewer: ReservationViewer } {
  return {
    id: 'r1',
    reference: 'BK-010492',
    typeCode: 'badminton_court',
    typeName: 'Badminton Court',
    resource: { id: 'court_1', name: 'Court 1' },
    date: '2026-08-20',
    startTime: '20:00',
    endTime: '21:00',
    startsAt: FAR_FUTURE,
    endsAt: FAR_FUTURE,
    durationMinutes: 60,
    status: 'confirmed',
    hourlyRateCents: 3000,
    amountPaidCents: 9000,
    clubId: null,
    seriesId: null,
    weekly: false,
    createdByAdmin: false,
    participants: [
      {
        memberId: 'org',
        firstName: 'Olivia',
        lastName: 'Zha',
        role: 'organizer',
        status: 'confirmed',
        invitedById: null,
      },
    ],
    pendingChange: null,
    viewer,
  };
}

const CAN_INVITE: ReservationViewer = {
  role: 'organizer',
  status: 'confirmed',
  canInvite: true,
  canManage: true,
  canRespond: false,
};

function renderInvite() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}
    >
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(<InviteMoreScreen reservationId="r1" />, { wrapper });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockReplace.mockClear();
});

describe('InviteMoreScreen load-error handling', () => {
  it('shows the terminal not-found gate for a 404 (outsider or missing)', async () => {
    jest.spyOn(api, 'getReservation').mockRejectedValue(new ApiError('NOT_FOUND', 'nope', 404));
    renderInvite();
    await waitFor(() => expect(screen.getByText('Reservation not found')).toBeTruthy());
    expect(screen.getByText('Back to home')).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('shows a retry (not the not-found gate) for a transient 5xx', async () => {
    jest.spyOn(api, 'getReservation').mockRejectedValue(new ApiError('SERVER_ERROR', 'boom', 500));
    renderInvite();
    await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy());
    // A member with a real reservation must not be told they are not part of it.
    expect(screen.queryByText('Reservation not found')).toBeNull();
  });

  it('recovers in place when Try again succeeds after a transient failure', async () => {
    jest
      .spyOn(api, 'getReservation')
      .mockRejectedValueOnce(new ApiError('SERVER_ERROR', 'boom', 500))
      .mockResolvedValue(makeReservation(CAN_INVITE));
    renderInvite();
    await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy());
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByText('invite-step-ready')).toBeTruthy());
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
