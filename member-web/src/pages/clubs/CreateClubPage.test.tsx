import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { api, type MemberSearchResult } from '../../lib/api';
import { ToastProvider } from '../../components';
import { CreateClubPage } from './CreateClubPage';

/**
 * The 2-step create wizard: step gating (GROUP NAME required), the invite
 * picker on step 2, and the create payload (name, description, initial
 * invitees) with navigation to the new club's detail.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      createClub: vi.fn(),
      uploadClubCover: vi.fn(),
      searchMembers: vi.fn(),
    },
  };
});

vi.mock('../../lib/session-context', () => ({
  useSession: () => ({ memberId: 'm-self' }),
}));

const createClub = vi.mocked(api.createClub);
const searchMembers = vi.mocked(api.searchMembers);

function member(id: string, firstName: string, lastName: string): MemberSearchResult {
  return {
    id,
    memberNumber: id.toUpperCase(),
    firstName,
    lastName,
    displayName: null,
    avatarUrl: null,
  };
}

function DetailProbe() {
  const { clubId } = useParams();
  return <p>club detail {clubId}</p>;
}

function renderWizard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/clubs/new']}>
          <Routes>
            <Route path="/clubs/new" element={<CreateClubPage />} />
            <Route path="/clubs" element={<p>clubs list</p>} />
            <Route path="/clubs/:clubId" element={<DetailProbe />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMembers.mockResolvedValue([member('m-wes', 'Wesley', 'Wang')]);
  createClub.mockResolvedValue({
    club: {
      id: 'club-1',
      name: 'baddies',
      description: null,
      coverImageUrl: null,
      memberCount: 1,
    },
    invited: ['m-wes'],
  });
});

describe('CreateClubPage', () => {
  it('gates Continue on the group name and announces step 1', async () => {
    renderWizard();

    expect(
      screen.getByRole('progressbar', { name: undefined }),
    ).toHaveAttribute('aria-valuetext', 'Step 1 of 2: Club details');
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Group name'), '   ');
    expect(continueButton).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Group name'));
    await userEvent.type(screen.getByLabelText('Group name'), 'baddies');
    expect(continueButton).toBeEnabled();
  });

  it('moves to the invite step and back without losing the details', async () => {
    renderWizard();

    await userEvent.type(screen.getByLabelText('Group name'), 'baddies');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Invite players' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      'Step 2 of 2: Invite players',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Create a club' })).toBeInTheDocument();
    expect(screen.getByLabelText('Group name')).toHaveValue('baddies');
  });

  it('creates the club with the picked invitees and lands on its detail', async () => {
    renderWizard();

    await userEvent.type(screen.getByLabelText('Group name'), '  baddies  ');
    await userEvent.type(screen.getByLabelText('Description'), 'the trouble');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await userEvent.click(
      await screen.findByRole('button', { name: 'Invite Wesley Wang' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create club' }));

    await waitFor(() =>
      expect(createClub).toHaveBeenCalledWith({
        name: 'baddies',
        description: 'the trouble',
        inviteeMemberIds: ['m-wes'],
      }),
    );
    expect(await screen.findByText('club detail club-1')).toBeInTheDocument();
    // No cover was picked, so nothing uploads.
    expect(api.uploadClubCover).not.toHaveBeenCalled();
  });

  it('creates without invitees or description when none are given', async () => {
    renderWizard();

    await userEvent.type(screen.getByLabelText('Group name'), 'solo club');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Invite players' });
    await userEvent.click(screen.getByRole('button', { name: 'Create club' }));

    await waitFor(() =>
      expect(createClub).toHaveBeenCalledWith({
        name: 'solo club',
        description: undefined,
        inviteeMemberIds: undefined,
      }),
    );
  });

  it('surfaces a create failure inline on the invite step', async () => {
    createClub.mockRejectedValue(new Error('boom'));
    renderWizard();

    await userEvent.type(screen.getByLabelText('Group name'), 'baddies');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Invite players' });
    await userEvent.click(screen.getByRole('button', { name: 'Create club' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not create the club. Try again.',
    );
    // Still on the wizard: no navigation happened.
    expect(screen.queryByText(/club detail/)).not.toBeInTheDocument();
  });
});
