import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, type ClubDetail, type ClubPermissionFlags } from '../../../lib/api';
import { ToastProvider } from '../../../components';
import { ClubDetailScreen } from '../ClubDetailScreen';

let mockMemberId = 'me';
jest.mock('../../../lib/session', () => ({
  useSession: () => ({ memberId: mockMemberId }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

const OWNER: ClubPermissionFlags = {
  canEdit: true,
  canDelete: true,
  canManageMembers: true,
  canInvite: true,
  canLeave: false,
};
const MEMBER: ClubPermissionFlags = {
  canEdit: false,
  canDelete: false,
  canManageMembers: false,
  canInvite: true,
  canLeave: true,
};

function makeClub(permissions: ClubPermissionFlags, overrides: Partial<ClubDetail> = {}): ClubDetail {
  return {
    id: 'club1',
    name: 'Baddies',
    description: 'the crew',
    coverImageUrl: null,
    memberCount: 6,
    myRole: permissions.canEdit ? 'owner' : 'member',
    permissions,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderDetail(club: ClubDetail) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['clubs', club.id], club);
  jest.spyOn(api, 'getClub').mockResolvedValue(club);
  jest.spyOn(api, 'getClubActivity').mockResolvedValue([]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}
    >
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(<ClubDetailScreen clubId={club.id} />, { wrapper });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockMemberId = 'me';
});

describe('ClubDetailScreen capability-driven actions', () => {
  it('owner: overflow menu has Edit + Delete and the cannot-leave hint, no Leave', () => {
    renderDetail(makeClub(OWNER));
    fireEvent.press(screen.getByLabelText('Club actions'));
    expect(screen.getByRole('button', { name: 'Edit club' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete club' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leave club' })).toBeNull();
    expect(screen.getByText(/As the owner you cannot leave this club/)).toBeTruthy();
  });

  it('member: overflow menu has Leave only, no Edit / Delete', () => {
    renderDetail(makeClub(MEMBER));
    fireEvent.press(screen.getByLabelText('Club actions'));
    expect(screen.getByRole('button', { name: 'Leave club' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit club' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete club' })).toBeNull();
  });

  it('shows the Invite action only when canInvite', () => {
    renderDetail(makeClub({ ...MEMBER, canInvite: false }));
    expect(screen.getByLabelText('Members')).toBeTruthy();
    expect(screen.queryByLabelText('Invite')).toBeNull();
  });

  it('hides the overflow menu entirely when there is nothing to manage', () => {
    // A member who cannot even leave (edge) has no menu.
    renderDetail(makeClub({ ...MEMBER, canLeave: false, canInvite: false }));
    expect(screen.queryByLabelText('Club actions')).toBeNull();
  });
});

describe('ClubDetailScreen leave / delete confirm flows', () => {
  it('leave: confirm sheet then POST leave', async () => {
    const leaveSpy = jest.spyOn(api, 'leaveClub').mockResolvedValue({ left: true });
    renderDetail(makeClub(MEMBER));
    fireEvent.press(screen.getByLabelText('Club actions'));
    fireEvent.press(screen.getByRole('button', { name: 'Leave club' }));
    // The confirm sheet is now open with its body copy.
    expect(
      screen.getByText('Leave Baddies? You will need a new invitation or invite link to rejoin.'),
    ).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Leave club' }));
    await waitFor(() => expect(leaveSpy).toHaveBeenCalledWith('club1'));
  });

  it('delete: confirm sheet then DELETE club', async () => {
    const deleteSpy = jest.spyOn(api, 'deleteClub').mockResolvedValue({ deleted: true });
    renderDetail(makeClub(OWNER));
    fireEvent.press(screen.getByLabelText('Club actions'));
    fireEvent.press(screen.getByRole('button', { name: 'Delete club' }));
    expect(screen.getByText(/Delete Baddies for 6 members\?/)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Delete club' }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('club1'));
  });
});
