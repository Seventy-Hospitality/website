import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, type ClubDetail, type ClubPermissionFlags, type ClubRosterEntry } from '../../../lib/api';
import { ToastProvider } from '../../../components';
import { ClubMembersScreen } from '../ClubMembersScreen';

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

function makeClub(permissions: ClubPermissionFlags): ClubDetail {
  return {
    id: 'club1',
    name: 'Baddies',
    description: null,
    coverImageUrl: null,
    memberCount: 2,
    myRole: permissions.canEdit ? 'owner' : 'member',
    permissions,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ROSTER: ClubRosterEntry[] = [
  {
    memberId: 'me',
    memberNumber: '284751',
    firstName: 'Olivia',
    lastName: 'Zha',
    displayName: null,
    avatarUrl: null,
    role: 'owner',
    joinedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    memberId: 'nadia',
    memberNumber: '193847',
    firstName: 'Nadia',
    lastName: 'Kowalski',
    displayName: null,
    avatarUrl: null,
    role: 'member',
    joinedAt: '2026-02-01T00:00:00.000Z',
  },
];

function renderMembers(club: ClubDetail, roster: ClubRosterEntry[] = ROSTER) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['clubs', club.id], club);
  client.setQueryData(['clubs', club.id, 'members'], roster);
  jest.spyOn(api, 'getClub').mockResolvedValue(club);
  jest.spyOn(api, 'getClubMembers').mockResolvedValue(roster);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}
    >
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(<ClubMembersScreen clubId={club.id} />, { wrapper });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockMemberId = 'me';
});

describe('ClubMembersScreen capability-driven rows', () => {
  it('owner: per-row menu on other non-owner members only, plus the invite +', () => {
    renderMembers(makeClub(OWNER));
    expect(screen.getByLabelText('Actions for Nadia Kowalski')).toBeTruthy();
    // No menu on the owner row (which is also self here).
    expect(screen.queryByLabelText('Actions for Olivia Zha')).toBeNull();
    expect(screen.getByLabelText('Invite to club')).toBeTruthy();
    expect(screen.getByText('Owner')).toBeTruthy();
  });

  it('member: no per-row menus', () => {
    mockMemberId = 'nadia';
    renderMembers(makeClub(MEMBER));
    expect(screen.queryByLabelText('Actions for Nadia Kowalski')).toBeNull();
    expect(screen.queryByLabelText('Actions for Olivia Zha')).toBeNull();
  });
});

describe('ClubMembersScreen owner actions', () => {
  it('transfer: member menu -> confirm -> PATCH role owner', async () => {
    const transferSpy = jest.spyOn(api, 'changeClubMemberRole').mockResolvedValue({ updated: true });
    renderMembers(makeClub(OWNER));
    fireEvent.press(screen.getByLabelText('Actions for Nadia Kowalski'));
    fireEvent.press(screen.getByRole('button', { name: 'Transfer ownership' }));
    expect(screen.getByText('Make Nadia Kowalski the owner of Baddies?')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Make Nadia Kowalski the owner' }));
    await waitFor(() => expect(transferSpy).toHaveBeenCalledWith('club1', 'nadia', 'owner'));
  });

  it('remove: member menu -> confirm -> DELETE member', async () => {
    const removeSpy = jest.spyOn(api, 'removeClubMember').mockResolvedValue({ removed: true });
    renderMembers(makeClub(OWNER));
    fireEvent.press(screen.getByLabelText('Actions for Nadia Kowalski'));
    fireEvent.press(screen.getByRole('button', { name: 'Remove from club' }));
    expect(screen.getByText('Remove Nadia Kowalski from Baddies? They can be invited again later.')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Remove from club' }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('club1', 'nadia'));
  });
});
