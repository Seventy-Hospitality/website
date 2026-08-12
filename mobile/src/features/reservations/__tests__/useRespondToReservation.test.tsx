import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError, type HomeFeed, type Reservation, type ReservationViewer } from '../../../lib/api';
import {
  applyResponseToDetail,
  applyResponseToHome,
  useRespondToReservation,
} from '../useRespondToReservation';

const MEMBER_ID = 'm_self';

jest.mock('../../../lib/session', () => ({
  useSession: () => ({ memberId: 'm_self' }),
}));

type ReservationDetail = Reservation & { viewer?: ReservationViewer };

function makeDetail(overrides: Partial<Reservation> = {}): ReservationDetail {
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
      { memberId: 'org', firstName: 'Olivia', lastName: 'Zha', role: 'organizer', status: 'confirmed', invitedById: null },
      { memberId: MEMBER_ID, firstName: 'Sam', lastName: 'Lee', role: 'guest', status: 'pending', invitedById: 'org' },
    ],
    pendingChange: null,
    myParticipation: { role: 'guest', status: 'pending', invitedByName: 'Olivia Zha', invitedByFirstName: 'Olivia' },
    viewer: { role: 'guest', status: 'pending', canInvite: false, canManage: false, canRespond: true },
    ...overrides,
  };
}

// ── Pure optimistic writes ──

describe('applyResponseToDetail', () => {
  it('flips the viewer row, myParticipation and viewer.status on accept', () => {
    const next = applyResponseToDetail(makeDetail(), MEMBER_ID, 'accept');
    expect(next.participants.find((r) => r.memberId === MEMBER_ID)?.status).toBe('confirmed');
    expect(next.myParticipation?.status).toBe('confirmed');
    expect(next.viewer?.status).toBe('confirmed');
  });

  it('is a no-op for an invalid transition (declined + accept)', () => {
    const detail = makeDetail({
      participants: [
        { memberId: MEMBER_ID, firstName: 'Sam', lastName: 'Lee', role: 'guest', status: 'declined', invitedById: 'org' },
      ],
    });
    expect(applyResponseToDetail(detail, MEMBER_ID, 'accept')).toBe(detail);
  });
});

describe('applyResponseToHome', () => {
  function makeHome(): HomeFeed {
    return {
      member: {} as HomeFeed['member'],
      greeting: {} as HomeFeed['greeting'],
      spotlightEvents: [],
      upcomingReservations: [],
      pendingInvitations: [makeDetail()],
      clubInvitations: [],
      quickBook: null,
      amenities: null,
    };
  }

  it('accepting moves a pending invitation into upcoming', () => {
    const next = applyResponseToHome(makeHome(), 'r1', MEMBER_ID, 'accept');
    expect(next.pendingInvitations).toHaveLength(0);
    expect(next.upcomingReservations.map((r) => r.id)).toEqual(['r1']);
    expect(next.upcomingReservations[0].participants.find((p) => p.memberId === MEMBER_ID)?.status).toBe(
      'confirmed',
    );
  });

  it('declining drops the pending invitation without adding it to upcoming', () => {
    const next = applyResponseToHome(makeHome(), 'r1', MEMBER_ID, 'decline');
    expect(next.pendingInvitations).toHaveLength(0);
    expect(next.upcomingReservations).toHaveLength(0);
  });

  it('declining an upcoming reservation (withdraw) removes that row', () => {
    const home: HomeFeed = { ...makeHome(), pendingInvitations: [], upcomingReservations: [makeDetail()] };
    const next = applyResponseToHome(home, 'r1', MEMBER_ID, 'decline');
    expect(next.upcomingReservations).toHaveLength(0);
  });
});

// ── The mutation: optimistic apply, rollback, conflict re-fetch ──

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useRespondToReservation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('optimistically flips the viewer row in the detail cache before the request resolves', async () => {
    const client = makeClient();
    client.setQueryData(['reservations', 'r1'], makeDetail());

    let resolveRespond: (value: { status: 'confirmed' }) => void = () => undefined;
    jest
      .spyOn(api, 'respondReservation')
      .mockReturnValue(new Promise((resolve) => (resolveRespond = resolve)));

    const { result } = renderHook(() => useRespondToReservation(), { wrapper: wrapperFor(client) });

    act(() => {
      result.current.mutate({ reservationId: 'r1', response: 'accept' });
    });

    await waitFor(() => {
      const cached = client.getQueryData<ReservationDetail>(['reservations', 'r1']);
      expect(cached?.participants.find((r) => r.memberId === MEMBER_ID)?.status).toBe('confirmed');
    });

    act(() => resolveRespond({ status: 'confirmed' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('rolls the detail cache back to its snapshot on error', async () => {
    const client = makeClient();
    const original = makeDetail();
    client.setQueryData(['reservations', 'r1'], original);
    jest.spyOn(api, 'respondReservation').mockRejectedValue(new ApiError('SERVER', 'boom', 500));

    const { result } = renderHook(() => useRespondToReservation(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ reservationId: 'r1', response: 'accept' }).catch(() => undefined);
    });

    const cached = client.getQueryData<ReservationDetail>(['reservations', 'r1']);
    expect(cached?.participants.find((r) => r.memberId === MEMBER_ID)?.status).toBe('pending');
  });

  it('re-fetches the reservation on a conflict (INVALID_STATUS) after rolling back', async () => {
    const client = makeClient();
    client.setQueryData(['reservations', 'r1'], makeDetail());
    jest
      .spyOn(api, 'respondReservation')
      .mockRejectedValue(new ApiError('INVALID_STATUS', 'gone', 409));
    const invalidate = jest.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useRespondToReservation(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ reservationId: 'r1', response: 'accept' }).catch(() => undefined);
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reservations', 'r1'] });
  });
});
