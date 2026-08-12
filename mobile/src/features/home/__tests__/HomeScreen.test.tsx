import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  api,
  ApiError,
  type ClubInvitation,
  type HomeAmenitySummary,
  type HomeFeed,
  type Reservation,
} from '../../../lib/api';
import { ToastProvider } from '../../../components';
import { HomeScreen } from '../HomeScreen';

jest.mock('../../../lib/session', () => ({ useSession: () => ({ memberId: 'm_self' }) }));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

const MEMBER: HomeFeed['member'] = {
  id: 'm_self',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Chen',
  phone: null,
  memberNumber: 'U00578',
  displayName: null,
  avatarUrl: null,
  memberSince: '2026-08-01T00:00:00.000Z',
  membership: null,
};

function invitationReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r1',
    reference: 'BK-1',
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
    amountPaidCents: 0,
    clubId: null,
    seriesId: null,
    weekly: false,
    createdByAdmin: false,
    participants: [
      { memberId: 'org', firstName: 'Sarah', lastName: 'Z', role: 'organizer', status: 'confirmed', invitedById: null },
      { memberId: 'm_self', firstName: 'Alice', lastName: 'C', role: 'guest', status: 'pending', invitedById: 'org' },
    ],
    pendingChange: null,
    myParticipation: { role: 'guest', status: 'pending', invitedByName: 'Sarah Z', invitedByFirstName: 'Sarah' },
    ...overrides,
  };
}

function acceptedReservation(): Reservation {
  return invitationReservation({
    participants: [
      { memberId: 'org', firstName: 'Sarah', lastName: 'Z', role: 'organizer', status: 'confirmed', invitedById: null },
      { memberId: 'm_self', firstName: 'Alice', lastName: 'C', role: 'guest', status: 'confirmed', invitedById: 'org' },
    ],
    myParticipation: { role: 'guest', status: 'confirmed', invitedByName: 'Sarah Z', invitedByFirstName: 'Sarah' },
  });
}

function makeFeed(overrides: Partial<HomeFeed> = {}): HomeFeed {
  return {
    member: MEMBER,
    greeting: { firstName: 'Alice', timeOfDay: 'evening', timezone: 'America/Los_Angeles' },
    spotlightEvents: [],
    upcomingReservations: [],
    pendingInvitations: [],
    clubInvitations: [],
    quickBook: null,
    amenities: null,
    ...overrides,
  };
}

function renderHome(initial: HomeFeed, getHomeResult: HomeFeed = initial) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['home'], initial);
  jest.spyOn(api, 'getHome').mockResolvedValue(getHomeResult);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}
    >
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(<HomeScreen />, { wrapper });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockRouterPush.mockReset();
});

describe('HomeScreen composition', () => {
  it('renders greeting, quick book and upcoming reservations in the populated layout', () => {
    renderHome(
      makeFeed({
        upcomingReservations: [invitationReservation({ myParticipation: { role: 'organizer', status: 'confirmed', invitedByName: null, invitedByFirstName: null } })],
        quickBook: {
          typeCode: 'mahjong_table',
          typeName: 'Mahjong Table',
          date: '2026-08-12',
          startTime: '07:00',
          endTime: '08:00',
          durationMinutes: 60,
          hourlyRateCents: 1000,
          reason: 'Mahjong Table has the most availability today',
        },
      }),
    );
    expect(screen.getByText('Good evening,')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByLabelText('Show membership card')).toBeTruthy();
    expect(screen.getByText('Quick book')).toBeTruthy();
    expect(screen.getByText('AI SUGGESTION')).toBeTruthy();
    expect(screen.getByText('Upcoming reservations')).toBeTruthy();
  });

  it('renders the first-session empty state (amenities present, nothing upcoming) instead of quick book', () => {
    const amenity: HomeAmenitySummary = {
      typeCode: 'badminton_court',
      typeName: 'Badminton Court',
      hourlyRateCents: 2000,
      resourceCount: 4,
      availableSlotsToday: 12,
      locked: false,
    };
    renderHome(makeFeed({ amenities: [amenity] }));
    expect(screen.getByText('Welcome,')).toBeTruthy();
    expect(screen.getByText('Reserve play')).toBeTruthy();
    expect(screen.getByLabelText('Book Badminton Court')).toBeTruthy();
    expect(screen.queryByText('Quick book')).toBeNull();
  });

  it('renders distinct pending invitation cards with inline Accept / Decline', () => {
    renderHome(makeFeed({ pendingInvitations: [invitationReservation()] }));
    expect(screen.getByText('SARAH')).toBeTruthy();
    expect(screen.getByLabelText('Accept invitation')).toBeTruthy();
    expect(screen.getByLabelText('Decline invitation')).toBeTruthy();
  });

  it('renders club invitations', () => {
    const invitation: ClubInvitation = {
      id: 'c1',
      club: { id: 'club-1', name: 'Baddies', description: null, coverImageUrl: null, memberCount: 6 },
      invitedBy: { memberId: 'colin', firstName: 'Colin', lastName: 'Ng' },
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    renderHome(makeFeed({ pendingInvitations: [invitationReservation()], clubInvitations: [invitation] }));
    expect(screen.getByText('Club invitations')).toBeTruthy();
    expect(screen.getByText('Baddies')).toBeTruthy();
    expect(screen.getByLabelText('Accept the Baddies invitation')).toBeTruthy();
  });
});

describe('HomeScreen inline invitation accept', () => {
  it('optimistically moves an accepted invitation out of the pending list', async () => {
    // While the request is in flight, the optimistic home write moves the card
    // into upcoming, so the Accept control unmounts. The request is left pending
    // (never resolves) so no settle refetch or success toast outlives the test.
    jest.spyOn(api, 'respondReservation').mockReturnValue(new Promise(() => undefined));

    renderHome(
      makeFeed({ pendingInvitations: [invitationReservation()] }),
      makeFeed({ upcomingReservations: [acceptedReservation()] }),
    );

    fireEvent.press(screen.getByLabelText('Accept invitation'));

    await waitFor(() => expect(screen.queryByLabelText('Accept invitation')).toBeNull());
    // The reservation now shows as an upcoming card (with its Date fact row).
    expect(screen.getByText('Date')).toBeTruthy();
  });

  it('rolls the pending invitation back when the response fails', async () => {
    jest.spyOn(api, 'respondReservation').mockRejectedValue(new ApiError('SERVER', 'boom', 500));

    renderHome(makeFeed({ pendingInvitations: [invitationReservation()] }));

    fireEvent.press(screen.getByLabelText('Accept invitation'));

    // After the error rolls the optimistic write back, the Accept control returns.
    await waitFor(() => expect(screen.getByLabelText('Accept invitation')).toBeTruthy());
  });
});
