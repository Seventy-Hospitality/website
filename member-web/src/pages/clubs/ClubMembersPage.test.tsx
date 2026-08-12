import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, type ClubDetail, type ClubRosterEntry } from '../../lib/api';
import { ToastProvider } from '../../components';
import { ClubMembersPage } from './ClubMembersPage';

/**
 * The roster: Owner badge, capability-gated per-row menus (owner only,
 * never on self or the owner row), and the transfer-ownership / remove
 * confirmation flows.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getClub: vi.fn(),
      getClubMembers: vi.fn(),
      changeClubMemberRole: vi.fn(),
      removeClubMember: vi.fn(),
      searchMembers: vi.fn(),
    },
  };
});

vi.mock('../../lib/session-context', () => ({
  useSession: () => ({ memberId: 'm-self' }),
}));

const getClub = vi.mocked(api.getClub);
const getClubMembers = vi.mocked(api.getClubMembers);
const changeClubMemberRole = vi.mocked(api.changeClubMemberRole);
const removeClubMember = vi.mocked(api.removeClubMember);

const OWNER_VIEW: ClubDetail = {
  id: 'club-1',
  name: 'baddies',
  description: null,
  coverImageUrl: null,
  memberCount: 3,
  myRole: 'owner',
  permissions: {
    canEdit: true,
    canDelete: true,
    canManageMembers: true,
    canInvite: true,
    canLeave: false,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const MEMBER_VIEW: ClubDetail = {
  ...OWNER_VIEW,
  myRole: 'member',
  permissions: {
    canEdit: false,
    canDelete: false,
    canManageMembers: false,
    canInvite: true,
    canLeave: true,
  },
};

function rosterEntry(
  memberId: string,
  firstName: string,
  lastName: string,
  role: 'owner' | 'member',
): ClubRosterEntry {
  return {
    memberId,
    memberNumber: memberId.toUpperCase(),
    firstName,
    lastName,
    displayName: null,
    avatarUrl: null,
    role,
    joinedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ROSTER_SELF_OWNER = [
  rosterEntry('m-self', 'Olivia', 'Zha', 'owner'),
  rosterEntry('m-nadia', 'Nadia', 'Kowalski', 'member'),
  rosterEntry('m-theo', 'Theo', 'Baptiste', 'member'),
];

const ROSTER_OTHER_OWNER = [
  rosterEntry('m-nadia', 'Nadia', 'Kowalski', 'owner'),
  rosterEntry('m-self', 'Olivia', 'Zha', 'member'),
  rosterEntry('m-theo', 'Theo', 'Baptiste', 'member'),
];

function renderMembers() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/clubs/club-1/members']}>
          <Routes>
            <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getClub.mockResolvedValue(OWNER_VIEW);
  getClubMembers.mockResolvedValue(ROSTER_SELF_OWNER);
  vi.mocked(api.searchMembers).mockResolvedValue([]);
});

describe('ClubMembersPage', () => {
  it('labels the owner and gives the managing owner menus for other members only', async () => {
    renderMembers();

    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.getByLabelText('Olivia Zha is the club owner')).toBeInTheDocument();

    // Menus: never on self (the owner here), present on the two members.
    expect(
      screen.queryByRole('button', { name: 'Actions for Olivia Zha' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Nadia Kowalski' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Theo Baptiste' })).toBeInTheDocument();

    // The invite entry point.
    expect(screen.getByRole('button', { name: 'Invite to club' })).toBeInTheDocument();
  });

  it('shows plain members no management menus at all', async () => {
    getClub.mockResolvedValue(MEMBER_VIEW);
    getClubMembers.mockResolvedValue(ROSTER_OTHER_OWNER);
    renderMembers();

    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    // Any member may still invite.
    expect(screen.getByRole('button', { name: 'Invite to club' })).toBeInTheDocument();
  });

  it('transfers ownership through the confirmation', async () => {
    changeClubMemberRole.mockResolvedValue({ updated: true });
    renderMembers();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Actions for Nadia Kowalski' }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog', { hidden: true, name: 'Nadia Kowalski' })).getByRole(
        'button',
        { name: 'Transfer ownership' },
      ),
    );

    const confirm = screen.getByRole('dialog', { hidden: true, name: 'Transfer ownership' });
    expect(within(confirm).getByText(/lose owner controls/)).toBeInTheDocument();
    await userEvent.click(
      within(confirm).getByRole('button', { name: 'Make Nadia Kowalski the owner' }),
    );

    await waitFor(() =>
      expect(changeClubMemberRole).toHaveBeenCalledWith('club-1', 'm-nadia', 'owner'),
    );
    expect(
      await screen.findByText('Nadia Kowalski is now the club owner.'),
    ).toBeInTheDocument();
  });

  it('removes a member through the confirmation', async () => {
    removeClubMember.mockResolvedValue({ removed: true });
    renderMembers();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Actions for Theo Baptiste' }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog', { hidden: true, name: 'Theo Baptiste' })).getByRole(
        'button',
        { name: 'Remove from club' },
      ),
    );

    const confirm = screen.getByRole('dialog', { hidden: true, name: 'Remove member' });
    expect(
      within(confirm).getByText(/Remove Theo Baptiste from baddies/),
    ).toBeInTheDocument();
    // The success invalidation refetches the roster; serve the post-removal
    // truth from here on.
    getClubMembers.mockResolvedValue(
      ROSTER_SELF_OWNER.filter((entry) => entry.memberId !== 'm-theo'),
    );
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove from club' }));

    await waitFor(() =>
      expect(removeClubMember).toHaveBeenCalledWith('club-1', 'm-theo'),
    );
    // The roster cache drops the row without waiting for a refetch.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Actions for Theo Baptiste' }),
      ).not.toBeInTheDocument(),
    );
  });
});
