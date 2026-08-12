import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, ApiError, type AuthIdentities } from '../../lib/api';
import { ToastProvider } from '../../components';
import { DeleteAccountPage } from './DeleteAccountPage';

/**
 * The delete-account flow's safety rails: no step-up proof means the
 * destructive action stays unreachable, the request fires only after the
 * focus-trapped confirm, bad proofs surface inline (never a toast with
 * the password), DELETION_BLOCKED renders the blocked state with its
 * reasons, and a 202 signs the account out locally.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getAuthIdentities: vi.fn(),
      requestReauthEmail: vi.fn(),
      deleteAccount: vi.fn(),
    },
  };
});

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock('../../lib/session-context', () => ({
  useSession: () => ({
    principal: { email: 'olivia@example.com' },
    signOut,
  }),
}));

const getAuthIdentities = vi.mocked(api.getAuthIdentities);
const requestReauthEmail = vi.mocked(api.requestReauthEmail);
const deleteAccount = vi.mocked(api.deleteAccount);

const PASSWORD_ACCOUNT: AuthIdentities = { hasPassword: true, identities: [] };
const OAUTH_ACCOUNT: AuthIdentities = {
  hasPassword: false,
  identities: [
    {
      provider: 'google',
      email: 'olivia@example.com',
      isPrivateRelay: false,
      linkedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/account/delete']}>
          <Routes>
            <Route path="/account/delete" element={<DeleteAccountPage />} />
            <Route path="/sign-in" element={<div>sign in screen</div>} />
            <Route path="/account/preferences" element={<div>preferences screen</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  signOut.mockResolvedValue(undefined);
  getAuthIdentities.mockResolvedValue(PASSWORD_ACCOUNT);
});

describe('DeleteAccountPage step-up gating', () => {
  it('keeps the destructive action unreachable without step-up proof', async () => {
    renderPage();

    const submit = await screen.findByRole('button', { name: 'Delete my account' });
    expect(submit).toBeDisabled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes only after the password AND the final confirm, then signs out', async () => {
    deleteAccount.mockResolvedValue({ status: 'completed' });

    renderPage();

    await userEvent.type(await screen.findByLabelText('Current password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    // Submitting only OPENS the confirm dialog; nothing was sent yet.
    expect(deleteAccount).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole('button', { name: 'Permanently delete my account' }),
    );

    expect(deleteAccount).toHaveBeenCalledWith({ password: 'hunter2' });
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(await screen.findByText('sign in screen')).toBeInTheDocument();
  });

  it('surfaces a failed step-up inline and keeps the account', async () => {
    deleteAccount.mockRejectedValue(new ApiError('STEP_UP_FAILED', 'Re-authentication failed', 403));

    renderPage();

    await userEvent.type(await screen.findByLabelText('Current password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Permanently delete my account' }),
    );

    expect(await screen.findByText('That password is incorrect.')).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('renders the blocked state with the backend reasons on DELETION_BLOCKED', async () => {
    deleteAccount.mockRejectedValue(
      new ApiError('DELETION_BLOCKED', 'Account deletion is blocked', 409, {
        reasons: ['an open payment dispute'],
      }),
    );

    renderPage();

    await userEvent.type(await screen.findByLabelText('Current password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Permanently delete my account' }),
    );

    expect(
      await screen.findByText('We cannot delete your account right now.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/an open payment dispute/)).toBeInTheDocument();
    // The step-up form is gone; the deletion stays blocked until resolved.
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe('DeleteAccountPage passwordless step-up', () => {
  beforeEach(() => {
    getAuthIdentities.mockResolvedValue(OAUTH_ACCOUNT);
  });

  it('walks the emailed-code path: send code, enter it, delete with reauthToken', async () => {
    requestReauthEmail.mockResolvedValue({ sent: true });
    deleteAccount.mockResolvedValue({ status: 'in_progress' });

    renderPage();

    // No password field for a passwordless account; the code flow gates.
    expect(await screen.findByText(/emailed code/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(requestReauthEmail).toHaveBeenCalled();
    expect(
      await screen.findByText(/We emailed a confirmation code to olivia@example.com/),
    ).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Confirmation code'), 'code-123');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Permanently delete my account' }),
    );

    expect(deleteAccount).toHaveBeenCalledWith({ reauthToken: 'code-123' });
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(await screen.findByText('sign in screen')).toBeInTheDocument();
  });

  it('explains a rejected or expired code inline', async () => {
    requestReauthEmail.mockResolvedValue({ sent: true });
    deleteAccount.mockRejectedValue(new ApiError('STEP_UP_FAILED', 'Re-authentication failed', 403));

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Email me a code' }));
    await userEvent.type(await screen.findByLabelText('Confirmation code'), 'stale');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Permanently delete my account' }),
    );

    expect(await screen.findByText(/That code was not accepted/)).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });
});
