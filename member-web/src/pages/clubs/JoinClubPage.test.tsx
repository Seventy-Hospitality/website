import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { api, ApiError, type ClubSummary } from '../../lib/api';
import { ToastProvider } from '../../components';
import { JoinClubPage } from './JoinClubPage';

/**
 * Join-via-link resolution: a valid token previews the club and joins, a
 * dead link (410: revoked / expired / used up) surfaces its reason, an
 * existing member gets the shortcut, and a token-less URL fails closed.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      previewClubInvite: vi.fn(),
      joinClub: vi.fn(),
    },
  };
});

const previewClubInvite = vi.mocked(api.previewClubInvite);
const joinClub = vi.mocked(api.joinClub);

const CLUB: ClubSummary = {
  id: 'club-1',
  name: 'baddies',
  description: 'the trouble',
  coverImageUrl: null,
  memberCount: 5,
};

function DetailProbe() {
  const { clubId } = useParams();
  return <p>club detail {clubId}</p>;
}

function renderJoin(entry = '/clubs/join?token=tok-1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/clubs/join" element={<JoinClubPage />} />
            <Route path="/clubs/:clubId" element={<DetailProbe />} />
            <Route path="/clubs" element={<p>clubs list</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  previewClubInvite.mockResolvedValue({ club: CLUB, alreadyMember: false });
});

describe('JoinClubPage', () => {
  it('previews the club behind a valid token and joins', async () => {
    joinClub.mockResolvedValue({ club: CLUB, joined: true, alreadyMember: false });
    renderJoin();

    expect(await screen.findByText('baddies')).toBeInTheDocument();
    expect(screen.getByText('5 Members')).toBeInTheDocument();
    expect(screen.getByText('the trouble')).toBeInTheDocument();
    expect(previewClubInvite).toHaveBeenCalledWith('tok-1');

    await userEvent.click(screen.getByRole('button', { name: 'Join club' }));

    await waitFor(() => expect(joinClub).toHaveBeenCalledWith('tok-1'));
    expect(await screen.findByText('club detail club-1')).toBeInTheDocument();
  });

  it('offers existing members the shortcut instead of joining again', async () => {
    previewClubInvite.mockResolvedValue({ club: CLUB, alreadyMember: true });
    renderJoin();

    expect(
      await screen.findByText('You are already a member of this club.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open baddies' })).toHaveAttribute(
      'href',
      '/clubs/club-1',
    );
    expect(screen.queryByRole('button', { name: 'Join club' })).not.toBeInTheDocument();
  });

  it.each([
    'This invite link has expired',
    'This invite link has been revoked',
    'This invite link has reached its usage limit',
  ])('surfaces the dead-link reason: %s', async (message) => {
    previewClubInvite.mockRejectedValue(new ApiError('INVITE_LINK_INVALID', message, 410));
    renderJoin();

    expect(await screen.findByText('Invite link not usable')).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join club' })).not.toBeInTheDocument();
  });

  it('keeps other failures retryable', async () => {
    previewClubInvite.mockRejectedValue(new ApiError('UNKNOWN', 'Request failed', 500));
    renderJoin();

    expect(
      await screen.findByText('We could not check this invite link.'),
    ).toBeInTheDocument();

    previewClubInvite.mockResolvedValue({ club: CLUB, alreadyMember: false });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('baddies')).toBeInTheDocument();
  });

  it('fails closed without a token', async () => {
    renderJoin('/clubs/join');

    expect(await screen.findByText('Invite link not valid')).toBeInTheDocument();
    expect(previewClubInvite).not.toHaveBeenCalled();
  });
});
