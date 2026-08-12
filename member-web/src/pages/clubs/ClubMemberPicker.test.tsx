import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type MemberSearchResult } from '../../lib/api';
import { EMPTY_INVITE_SELECTION, type InviteSelection } from '../../lib/invites';
import { ClubMemberPicker } from './ClubMemberPicker';

/**
 * The directory-backed invite picker: the default directory page before
 * any query, debounced search, chip add/remove, exclusion of the viewer
 * and current club members.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: { ...original.api, searchMembers: vi.fn() },
  };
});

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

const DIRECTORY = [
  member('m1', 'Nadia', 'Kowalski'),
  member('m2', 'Theo', 'Baptiste'),
  member('m3', 'Wesley', 'Wang'),
];

function Harness({ exclude = [] }: { exclude?: string[] }) {
  const [selection, setSelection] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);
  return (
    <ClubMemberPicker
      selection={selection}
      onSelectionChange={setSelection}
      excludeMemberIds={exclude}
    />
  );
}

function renderPicker(exclude?: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness exclude={exclude} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMembers.mockImplementation((q: string) =>
    Promise.resolve(
      q
        ? DIRECTORY.filter((row) =>
            `${row.firstName} ${row.lastName}`.toLowerCase().includes(q.toLowerCase()),
          )
        : DIRECTORY,
    ),
  );
});

describe('ClubMemberPicker', () => {
  it('lists the default directory page before any search', async () => {
    renderPicker();

    // Row names are asserted via the toggle buttons: the Avatar fallback
    // also carries the visually hidden name, so plain text is ambiguous.
    expect(
      await screen.findByRole('button', { name: 'Invite Nadia Kowalski' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite Theo Baptiste' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite Wesley Wang' })).toBeInTheDocument();
    // Directory mode: no q parameter, the wider picker page size.
    expect(searchMembers).toHaveBeenCalledWith('', 25);
  });

  it('hides excluded members (the viewer and current club members)', async () => {
    renderPicker(['m1', 'm3']);

    expect(
      await screen.findByRole('button', { name: 'Invite Theo Baptiste' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Invite Nadia Kowalski' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Invite Wesley Wang' }),
    ).not.toBeInTheDocument();
  });

  it('searches by name after the debounce and swaps the list', async () => {
    renderPicker();
    await screen.findByRole('button', { name: 'Invite Nadia Kowalski' });

    await userEvent.type(screen.getByRole('searchbox'), 'wes');

    await waitFor(() => expect(searchMembers).toHaveBeenCalledWith('wes', 25));
    expect(
      await screen.findByRole('button', { name: 'Invite Wesley Wang' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Invite Nadia Kowalski' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('toggles members into chips and removes them from the chip', async () => {
    renderPicker();

    const invite = await screen.findByRole('button', { name: 'Invite Nadia Kowalski' });
    expect(invite).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(invite);

    const chips = screen.getByRole('list', { name: 'Selected players' });
    expect(within(chips).getByText('Nadia Kowalski')).toBeInTheDocument();
    // Both the row toggle and the chip remove button carry this name; the
    // toggle is the one with the pressed state.
    const rowToggle = screen
      .getAllByRole('button', { name: 'Remove Nadia Kowalski' })
      .find((button) => button.hasAttribute('aria-pressed'));
    expect(rowToggle).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(chips).getByRole('button', { name: 'Remove Nadia Kowalski' }));
    expect(screen.queryByRole('list', { name: 'Selected players' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Invite Nadia Kowalski' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the no-results empty state for a fruitless search', async () => {
    renderPicker();
    await screen.findByRole('button', { name: 'Invite Nadia Kowalski' });

    await userEvent.type(screen.getByRole('searchbox'), 'zzz');

    expect(await screen.findByText('No members found')).toBeInTheDocument();
  });
});
