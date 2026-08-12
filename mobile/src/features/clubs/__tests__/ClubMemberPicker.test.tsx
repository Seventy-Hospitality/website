import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type MemberSearchResult } from '../../../lib/api';
import { EMPTY_INVITE_SELECTION, type InviteSelection } from '../../reserve/invites';
import { ClubMemberPicker } from '../ClubMemberPicker';

function member(id: string, firstName: string, lastName: string): MemberSearchResult {
  return { id, memberNumber: id.toUpperCase(), firstName, lastName, displayName: null, avatarUrl: null };
}

const DIRECTORY = [
  member('wesley', 'Wesley', 'Wang'),
  member('nadia', 'Nadia', 'Kowalski'),
  member('theo', 'Theo', 'Baptiste'),
];

/** Controlled host so the picker's selection updates reflect in re-renders. */
function Host({ exclude }: { exclude?: string[] }) {
  const [selection, setSelection] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);
  return (
    <ClubMemberPicker selection={selection} onSelectionChange={setSelection} excludeMemberIds={exclude} />
  );
}

function renderHost(exclude?: string[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<Host exclude={exclude} />, { wrapper });
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(api, 'searchMembers').mockResolvedValue(DIRECTORY);
});

describe('ClubMemberPicker chip + selection logic', () => {
  it('toggles a player on, shows a chip, and removes it via the chip', async () => {
    renderHost();
    await waitFor(() => expect(screen.getByLabelText('Invite Wesley Wang')).toBeTruthy());

    // Select via the row checkbox.
    fireEvent.press(screen.getByLabelText('Invite Wesley Wang'));

    // The row flips to "Remove ..." (checkbox) and a removable chip appears (button).
    expect(screen.getByRole('checkbox', { name: 'Remove Wesley Wang' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Wesley Wang' })).toBeTruthy();

    // Remove via the chip's remove button.
    fireEvent.press(screen.getByRole('button', { name: 'Remove Wesley Wang' }));
    expect(screen.getByLabelText('Invite Wesley Wang')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Wesley Wang' })).toBeNull();
  });

  it('excludes current members from the directory', async () => {
    renderHost(['wesley']);
    await waitFor(() => expect(screen.getByText('Nadia Kowalski')).toBeTruthy());
    expect(screen.queryByText('Wesley Wang')).toBeNull();
  });
});
