import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, type ClubSummary } from '../../../lib/api';
import { ToastProvider } from '../../../components';
import { CreateClubScreen } from '../CreateClubScreen';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn(), canGoBack: () => true }),
}));

jest.mock('../../../lib/session', () => ({
  useSession: () => ({ memberId: 'me' }),
}));

function renderCreate() {
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
  return render(<CreateClubScreen />, { wrapper });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockReplace.mockClear();
  jest.spyOn(api, 'searchMembers').mockResolvedValue([]);
});

describe('CreateClubScreen step gating', () => {
  it('gates Continue on a non-empty name', () => {
    renderCreate();
    expect(screen.getByText('Create a club')).toBeTruthy();
    // Empty name: Continue is disabled, pressing it does not advance.
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByText('Invite players')).toBeNull();

    fireEvent.changeText(screen.getByPlaceholderText('Enter name'), 'Baddies');
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Invite players')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create club' })).toBeTruthy();
  });

  it('creates a club with no invitees and routes to the new club', async () => {
    const created: { club: ClubSummary; invited: string[] } = {
      club: { id: 'club9', name: 'Baddies', description: null, coverImageUrl: null, memberCount: 1 },
      invited: [],
    };
    const createSpy = jest.spyOn(api, 'createClub').mockResolvedValue(created);

    renderCreate();
    fireEvent.changeText(screen.getByPlaceholderText('Enter name'), 'Baddies');
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.press(screen.getByRole('button', { name: 'Create club' }));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith({
        name: 'Baddies',
        description: undefined,
        inviteeMemberIds: undefined,
      }),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/clubs/club9'));
  });
});
