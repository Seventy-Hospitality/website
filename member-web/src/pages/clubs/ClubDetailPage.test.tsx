import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  api,
  ApiError,
  type ClubActivityItem,
  type ClubDetail,
  type MyClub,
} from '../../lib/api';
import { ToastProvider } from '../../components';
import { ClubDetailPage } from './ClubDetailPage';

/**
 * Owner-vs-member action gating from the backend's permission flags, the
 * delete and optimistic-leave confirm flows, the activity feed rows
 * (upcoming badge, participant-only links), and the outsider 404 shape.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getClub: vi.fn(),
      getClubActivity: vi.fn(),
      getClubMembers: vi.fn(),
      deleteClub: vi.fn(),
      leaveClub: vi.fn(),
      searchMembers: vi.fn(),
      createClubInviteLink: vi.fn(),
    },
  };
});

vi.mock('../../lib/session-context', () => ({
  useSession: () => ({ memberId: 'm-self' }),
}));

const getClub = vi.mocked(api.getClub);
const getClubActivity = vi.mocked(api.getClubActivity);
const deleteClub = vi.mocked(api.deleteClub);
const leaveClub = vi.mocked(api.leaveClub);

const OWNER_CLUB: ClubDetail = {
  id: 'club-1',
  name: 'baddies',
  description: 'the trouble',
  coverImageUrl: null,
  memberCount: 5,
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

const MEMBER_CLUB: ClubDetail = {
  ...OWNER_CLUB,
  myRole: 'member',
  permissions: {
    canEdit: false,
    canDelete: false,
    canManageMembers: false,
    canInvite: true,
    canLeave: true,
  },
};

function activityItem(overrides: Partial<ClubActivityItem> = {}): ClubActivityItem {
  return {
    id: 'r1',
    reference: 'BK-000123',
    typeCode: 'badminton_court',
    typeName: 'Badminton Court',
    resource: { id: 'c3', name: 'Court 3' },
    date: '2030-06-27',
    startTime: '09:00',
    endTime: '11:30',
    startsAt: '2030-06-27T13:00:00.000Z',
    endsAt: '2030-06-27T15:30:00.000Z',
    durationMinutes: 150,
    status: 'confirmed',
    clubId: 'club-1',
    seriesId: null,
    organizer: { memberId: 'm-oli', firstName: 'Olivia', lastName: 'Zha' },
    confirmedCount: 5,
    myParticipation: { role: 'guest', status: 'confirmed', invitedByName: 'Olivia Zha' },
    ...overrides,
  };
}

function renderDetail(queryClient?: QueryClient) {
  const client =
    queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/clubs/club-1']}>
          <Routes>
            <Route path="/clubs/:clubId" element={<ClubDetailPage />} />
            <Route path="/clubs" element={<p>clubs list</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getClub.mockResolvedValue(OWNER_CLUB);
  getClubActivity.mockResolvedValue([]);
  vi.mocked(api.getClubMembers).mockResolvedValue([]);
  vi.mocked(api.searchMembers).mockResolvedValue([]);
});

describe('ClubDetailPage', () => {
  it('shows the owner menu (edit + delete, no leave) from the capability flags', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'baddies' })).toBeInTheDocument();
    expect(screen.getByText('5 Members')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('the trouble')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Club actions' }));
    const menu = screen.getByRole('dialog', { hidden: true, name: 'baddies' });
    expect(within(menu).getByRole('button', { name: 'Edit club' })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Delete club' })).toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: 'Leave club' })).not.toBeInTheDocument();
    expect(within(menu).getByText(/transfer ownership to another member/)).toBeInTheDocument();
  });

  it('shows the member menu (leave only) and keeps the shared actions', async () => {
    getClub.mockResolvedValue(MEMBER_CLUB);
    renderDetail();
    await screen.findByRole('heading', { name: 'baddies' });

    // The shared action bar is capability-independent apart from Invite.
    expect(screen.getByRole('link', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book for baddies' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Club actions' }));
    const menu = screen.getByRole('dialog', { hidden: true, name: 'baddies' });
    expect(within(menu).getByRole('button', { name: 'Leave club' })).toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: 'Edit club' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: 'Delete club' })).not.toBeInTheDocument();
  });

  it('deletes the club after confirmation and returns to the list', async () => {
    deleteClub.mockResolvedValue({ deleted: true });
    renderDetail();
    await screen.findByRole('heading', { name: 'baddies' });

    await userEvent.click(screen.getByRole('button', { name: 'Club actions' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { hidden: true, name: 'baddies' })).getByRole('button', {
        name: 'Delete club',
      }),
    );

    const confirm = screen.getByRole('dialog', { hidden: true, name: 'Delete club' });
    expect(within(confirm).getByText(/cannot be undone/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete club' }));

    await waitFor(() => expect(deleteClub).toHaveBeenCalledWith('club-1'));
    expect(await screen.findByText('clubs list')).toBeInTheDocument();
  });

  it('leaves optimistically: the club drops from the cached list before the reply', async () => {
    getClub.mockResolvedValue(MEMBER_CLUB);
    let resolveLeave: (value: { left: boolean }) => void = () => undefined;
    leaveClub.mockImplementation(
      () => new Promise((resolve) => (resolveLeave = resolve)),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const listRow: MyClub = {
      ...MEMBER_CLUB,
      joinedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    queryClient.setQueryData(['clubs'], [listRow]);

    renderDetail(queryClient);
    await screen.findByRole('heading', { name: 'baddies' });

    await userEvent.click(screen.getByRole('button', { name: 'Club actions' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { hidden: true, name: 'baddies' })).getByRole('button', {
        name: 'Leave club',
      }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog', { hidden: true, name: 'Leave club' })).getByRole(
        'button',
        { name: 'Leave club' },
      ),
    );

    // Optimistic: back on the list with the club gone BEFORE the server reply.
    expect(await screen.findByText('clubs list')).toBeInTheDocument();
    expect(queryClient.getQueryData<MyClub[]>(['clubs'])).toEqual([]);

    resolveLeave({ left: true });
    await waitFor(() => expect(leaveClub).toHaveBeenCalledWith('club-1'));
  });

  it('rolls the list back when leaving fails', async () => {
    getClub.mockResolvedValue(MEMBER_CLUB);
    leaveClub.mockRejectedValue(
      new ApiError('OWNER_MUST_TRANSFER', 'Transfer first', 409),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const listRow: MyClub = {
      ...MEMBER_CLUB,
      joinedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    queryClient.setQueryData(['clubs'], [listRow]);

    renderDetail(queryClient);
    await screen.findByRole('heading', { name: 'baddies' });
    await userEvent.click(screen.getByRole('button', { name: 'Club actions' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { hidden: true, name: 'baddies' })).getByRole('button', {
        name: 'Leave club',
      }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog', { hidden: true, name: 'Leave club' })).getByRole(
        'button',
        { name: 'Leave club' },
      ),
    );

    await waitFor(() =>
      expect(queryClient.getQueryData<MyClub[]>(['clubs'])).toEqual([listRow]),
    );
    expect(
      await screen.findByText('Transfer ownership to another member before leaving.'),
    ).toBeInTheDocument();
  });

  it('renders activity rows with the upcoming badge and participant-only links', async () => {
    getClubActivity.mockResolvedValue([
      activityItem(),
      activityItem({
        id: 'r2',
        date: '2020-06-13',
        startsAt: '2020-06-13T17:00:00.000Z',
        endsAt: '2020-06-13T19:00:00.000Z',
        startTime: '13:00',
        endTime: '15:00',
        confirmedCount: 3,
        resource: { id: 'c2', name: 'Court 2' },
        myParticipation: null,
      }),
    ]);
    renderDetail();
    await screen.findByRole('heading', { name: 'baddies' });

    // The viewer participates in r1: it links to the reservation detail.
    const upcomingRow = await screen.findByRole('link', { name: /6\/27/ });
    expect(upcomingRow).toHaveAttribute('href', '/reservations/r1');
    expect(within(upcomingRow).getByText('Upcoming')).toBeInTheDocument();
    expect(within(upcomingRow).getByText(/Court 3 · 5 players/)).toBeInTheDocument();

    // r2 is not the viewer's reservation: no link, no badge.
    expect(screen.getByText(/Court 2 · 3 players/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /6\/13/ })).not.toBeInTheDocument();
  });

  it('shows the empty activity state with the create-an-event path', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'baddies' });

    expect(await screen.findByText('No group activity yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an event' })).toHaveAttribute(
      'href',
      '/reserve?club=club-1',
    );
  });

  it('handles the outsider 404 shape gracefully', async () => {
    getClub.mockRejectedValue(new ApiError('NOT_FOUND', 'Club not found', 404));
    renderDetail();

    expect(await screen.findByText('Club not found')).toBeInTheDocument();
    expect(
      screen.getByText(/does not exist, was deleted, or you are not a member/),
    ).toBeInTheDocument();
  });
});
