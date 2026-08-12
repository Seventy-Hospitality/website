import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, ApiError, type ClubInvitePreview, type ClubJoinResult } from '../../../lib/api';
import { ToastProvider } from '../../../components';
import { JoinClubScreen } from '../JoinClubScreen';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn(), canGoBack: () => true }),
}));

function renderJoin(token: string | null) {
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
  return render(<JoinClubScreen token={token} />, { wrapper });
}

function preview(overrides: Partial<ClubInvitePreview> = {}): ClubInvitePreview {
  return {
    club: { id: 'club1', name: 'Baddies', description: 'the crew', coverImageUrl: null, memberCount: 6 },
    alreadyMember: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockReplace.mockClear();
});

describe('JoinClubScreen link resolution', () => {
  it('shows the missing-code state when there is no token', () => {
    renderJoin(null);
    expect(screen.getByText('Invite link not valid')).toBeTruthy();
  });

  it('previews a valid link and offers Join', async () => {
    jest.spyOn(api, 'previewClubInvite').mockResolvedValue(preview());
    renderJoin('good-token');
    await waitFor(() => expect(screen.getByText('You are invited to join')).toBeTruthy());
    expect(screen.getByText('Baddies')).toBeTruthy();
    expect(screen.getByText('6 Members')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Join club' })).toBeTruthy();
  });

  it('offers Open (not Join) when already a member', async () => {
    jest.spyOn(api, 'previewClubInvite').mockResolvedValue(preview({ alreadyMember: true }));
    renderJoin('good-token');
    await waitFor(() => expect(screen.getByText('You are already a member of this club.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Open Baddies' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join club' })).toBeNull();
  });

  it('joins and routes into the club on Join', async () => {
    jest.spyOn(api, 'previewClubInvite').mockResolvedValue(preview());
    const result: ClubJoinResult = { club: preview().club, joined: true, alreadyMember: false };
    const joinSpy = jest.spyOn(api, 'joinClub').mockResolvedValue(result);
    renderJoin('good-token');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join club' })).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: 'Join club' }));
    await waitFor(() => expect(joinSpy).toHaveBeenCalledWith('good-token'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/clubs/club1'));
  });

  it('shows the expired-link reason from a 410', async () => {
    jest
      .spyOn(api, 'previewClubInvite')
      .mockRejectedValue(new ApiError('INVITE_LINK_INVALID', 'This invite link has expired', 410));
    renderJoin('dead-token');
    await waitFor(() => expect(screen.getByText('Invite link not usable')).toBeTruthy());
    expect(
      screen.getByText('This invite link has expired Ask a club member for a fresh invite link.'),
    ).toBeTruthy();
  });

  it('shows the not-valid reason from a 404', async () => {
    jest.spyOn(api, 'previewClubInvite').mockRejectedValue(new ApiError('NOT_FOUND', 'nope', 404));
    renderJoin('unknown-token');
    await waitFor(() => expect(screen.getByText('Invite link not usable')).toBeTruthy());
    expect(
      screen.getByText('This invite link is not valid. Ask a club member for a fresh invite link.'),
    ).toBeTruthy();
  });
});
