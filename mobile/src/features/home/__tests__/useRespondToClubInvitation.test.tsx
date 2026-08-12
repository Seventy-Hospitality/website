import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError, type ClubInvitation, type HomeFeed } from '../../../lib/api';
import { useRespondToClubInvitation } from '../home-data';

function makeInvitation(id: string): ClubInvitation {
  return {
    id,
    club: { id: `club-${id}`, name: 'Baddies', description: null, coverImageUrl: null, memberCount: 6 },
    invitedBy: { memberId: 'colin', firstName: 'Colin', lastName: 'Ng' },
    createdAt: '2026-08-10T00:00:00.000Z',
  };
}

function makeHome(invitations: ClubInvitation[]): HomeFeed {
  return {
    member: {} as HomeFeed['member'],
    greeting: {} as HomeFeed['greeting'],
    spotlightEvents: [],
    upcomingReservations: [],
    pendingInvitations: [],
    clubInvitations: invitations,
    quickBook: null,
    amenities: null,
  };
}

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

describe('useRespondToClubInvitation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('optimistically removes the invitation from the home feed before the request resolves', async () => {
    const client = makeClient();
    client.setQueryData(['home'], makeHome([makeInvitation('c1'), makeInvitation('c2')]));

    let resolve: (value: { status: string; clubId: string }) => void = () => undefined;
    jest
      .spyOn(api, 'respondClubInvitation')
      .mockReturnValue(new Promise((r) => (resolve = r)));

    const { result } = renderHook(() => useRespondToClubInvitation(), { wrapper: wrapperFor(client) });

    act(() => {
      result.current.mutate({ invitationId: 'c1', response: 'accept' });
    });

    await waitFor(() => {
      const home = client.getQueryData<HomeFeed>(['home']);
      expect(home?.clubInvitations.map((row) => row.id)).toEqual(['c2']);
    });

    act(() => resolve({ status: 'accepted', clubId: 'club-c1' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('also drops the row from the shared club-invitations list', async () => {
    const client = makeClient();
    client.setQueryData(['home'], makeHome([makeInvitation('c1')]));
    client.setQueryData(['club-invitations'], [makeInvitation('c1'), makeInvitation('c2')]);
    jest.spyOn(api, 'respondClubInvitation').mockResolvedValue({ status: 'declined', clubId: 'club-c1' });

    const { result } = renderHook(() => useRespondToClubInvitation(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ invitationId: 'c1', response: 'decline' });
    });

    expect(client.getQueryData<ClubInvitation[]>(['club-invitations'])?.map((r) => r.id)).toEqual(['c2']);
  });

  it('rolls the home feed back to its snapshot on error', async () => {
    const client = makeClient();
    client.setQueryData(['home'], makeHome([makeInvitation('c1')]));
    jest.spyOn(api, 'respondClubInvitation').mockRejectedValue(new ApiError('SERVER', 'boom', 500));

    const { result } = renderHook(() => useRespondToClubInvitation(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ invitationId: 'c1', response: 'accept' }).catch(() => undefined);
    });

    expect(client.getQueryData<HomeFeed>(['home'])?.clubInvitations.map((r) => r.id)).toEqual(['c1']);
  });

  it('re-fetches the truth on a conflict (INVALID_INVITATION_STATE)', async () => {
    const client = makeClient();
    client.setQueryData(['home'], makeHome([makeInvitation('c1')]));
    jest
      .spyOn(api, 'respondClubInvitation')
      .mockRejectedValue(new ApiError('INVALID_INVITATION_STATE', 'gone', 409));
    const invalidate = jest.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useRespondToClubInvitation(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync({ invitationId: 'c1', response: 'accept' }).catch(() => undefined);
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['home'] });
  });
});
