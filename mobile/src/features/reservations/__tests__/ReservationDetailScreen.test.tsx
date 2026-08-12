import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, ApiError, type Reservation, type ReservationParticipant, type ReservationViewer } from '../../../lib/api';
import { ToastProvider } from '../../../components';
import { ReservationDetailScreen } from '../ReservationDetailScreen';

let mockMemberId = 'org';

jest.mock('../../../lib/session', () => ({
  useSession: () => ({ memberId: mockMemberId }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

const ORG: ReservationParticipant = {
  memberId: 'org',
  firstName: 'Olivia',
  lastName: 'Zha',
  role: 'organizer',
  status: 'confirmed',
  invitedById: null,
};

function guest(status: ReservationParticipant['status'], memberId = 'm_self'): ReservationParticipant {
  return { memberId, firstName: 'Sam', lastName: 'Lee', role: 'guest', status, invitedById: 'org' };
}

// A start time comfortably beyond the 24h refund tier so cancel shows 100%.
const FAR_FUTURE = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

function makeDetail(
  viewer: ReservationViewer,
  participants: ReservationParticipant[],
  overrides: Partial<Reservation> = {},
): Reservation & { viewer: ReservationViewer } {
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
    participants,
    pendingChange: null,
    viewer,
    ...overrides,
  };
}

function renderDetail(detail: Reservation & { viewer: ReservationViewer }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['reservations', detail.id], detail);
  jest.spyOn(api, 'getReservation').mockResolvedValue(detail);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}
    >
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(<ReservationDetailScreen reservationId={detail.id} />, { wrapper });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockMemberId = 'org';
});

describe('ReservationDetailScreen capability-flag-driven actions', () => {
  it('organizer sees Edit + Cancel + Invite and no respond pills', () => {
    mockMemberId = 'org';
    renderDetail(
      makeDetail(
        { role: 'organizer', status: 'confirmed', canInvite: true, canManage: true, canRespond: false },
        [ORG, guest('pending')],
      ),
    );
    expect(screen.getByText('Edit reservation')).toBeTruthy();
    expect(screen.getByLabelText('Cancel reservation')).toBeTruthy();
    expect(screen.getByLabelText('Invite players')).toBeTruthy();
    expect(screen.queryByLabelText('Accept invitation')).toBeNull();
  });

  it('a pending invitee sees ACCEPT / DECLINE on their own row, no organizer actions', () => {
    mockMemberId = 'm_self';
    renderDetail(
      makeDetail(
        { role: 'guest', status: 'pending', canInvite: false, canManage: false, canRespond: true },
        [ORG, guest('pending')],
      ),
    );
    expect(screen.getByLabelText('Accept invitation')).toBeTruthy();
    expect(screen.getByLabelText('Decline invitation')).toBeTruthy();
    expect(screen.queryByText('Edit reservation')).toBeNull();
    expect(screen.queryByLabelText('Invite players')).toBeNull();
  });

  it('an accepted participant sees the withdraw link, not the respond pills', () => {
    mockMemberId = 'm_self';
    renderDetail(
      makeDetail(
        { role: 'guest', status: 'confirmed', canInvite: true, canManage: false, canRespond: true },
        [ORG, guest('confirmed')],
      ),
    );
    expect(screen.getByText('Decline reservation')).toBeTruthy();
    expect(screen.queryByLabelText('Accept invitation')).toBeNull();
    expect(screen.queryByText('Edit reservation')).toBeNull();
  });
});

describe('ReservationDetailScreen cancel refund-tier preview', () => {
  it('shows a 100% refund of the amount paid more than 24h before start', () => {
    mockMemberId = 'org';
    renderDetail(
      makeDetail(
        { role: 'organizer', status: 'confirmed', canInvite: true, canManage: true, canRespond: false },
        [ORG],
        { amountPaidCents: 9000, startsAt: FAR_FUTURE },
      ),
    );
    fireEvent.press(screen.getByLabelText('Cancel reservation'));
    expect(screen.getByText('Refund to your card (100%)')).toBeTruthy();
    // $90.00 shows twice at the 100% tier: "Amount paid" and the full refund.
    expect(screen.getAllByText('$90.00')).toHaveLength(2);
  });

  it('shows a 50% refund inside the 2-24h tier', () => {
    mockMemberId = 'org';
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    renderDetail(
      makeDetail(
        { role: 'organizer', status: 'confirmed', canInvite: true, canManage: true, canRespond: false },
        [ORG],
        { amountPaidCents: 9000, startsAt: soon },
      ),
    );
    fireEvent.press(screen.getByLabelText('Cancel reservation'));
    expect(screen.getByText('Refund to your card (50%)')).toBeTruthy();
    expect(screen.getByText('$45.00')).toBeTruthy();
  });
});

describe('ReservationDetailScreen not-found', () => {
  it('renders the not-found state for a 404 (outsider or missing)', async () => {
    mockMemberId = 'stranger';
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    jest.spyOn(api, 'getReservation').mockRejectedValue(new ApiError('NOT_FOUND', 'nope', 404));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SafeAreaProvider
        initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}
      >
        <QueryClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    );
    render(<ReservationDetailScreen reservationId="r1" />, { wrapper });
    await waitFor(() => expect(screen.getByText('Reservation not found')).toBeTruthy());
  });
});
