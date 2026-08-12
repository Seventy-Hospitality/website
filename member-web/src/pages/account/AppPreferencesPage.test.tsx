import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { api, type NotificationPreferences } from '../../lib/api';
import { ToastProvider } from '../../components';
import { AppPreferencesPage } from './AppPreferencesPage';

/**
 * The notification toggles save independently on change: each PUT carries
 * ONLY its own key, flips optimistically, and rolls back (that key only)
 * with an error toast when the save fails.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getPreferences: vi.fn(),
      updatePreferences: vi.fn(),
    },
  };
});

const getPreferences = vi.mocked(api.getPreferences);
const updatePreferences = vi.mocked(api.updatePreferences);

const INITIAL: NotificationPreferences = {
  pushNotifications: true,
  emailNotifications: false,
  bookingReminders: true,
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/account/preferences']}>
          <AppPreferencesPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getPreferences.mockResolvedValue(INITIAL);
});

describe('AppPreferencesPage toggles', () => {
  it('renders the three switches from the server state', async () => {
    renderPage();

    expect(await screen.findByRole('switch', { name: 'Push notifications' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Email notifications' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Booking reminders' })).toBeChecked();
  });

  it('saves a toggle on change with ONLY its own key, optimistically', async () => {
    // Hold the PUT open so the optimistic state is observable.
    let resolvePut!: (value: NotificationPreferences) => void;
    updatePreferences.mockImplementation(
      () => new Promise<NotificationPreferences>((resolve) => (resolvePut = resolve)),
    );
    // After the settle-time invalidation the server agrees with the save.
    getPreferences
      .mockResolvedValueOnce(INITIAL)
      .mockResolvedValue({ ...INITIAL, emailNotifications: true });

    renderPage();

    const email = await screen.findByRole('switch', { name: 'Email notifications' });
    await userEvent.click(email);

    // Optimistic: checked before the server answers, and the PUT carries
    // only the flipped key (a stale client must not clobber the others).
    expect(email).toBeChecked();
    expect(updatePreferences).toHaveBeenCalledWith({ emailNotifications: true });

    resolvePut({ ...INITIAL, emailNotifications: true });
    await waitFor(() => expect(email).toBeChecked());
    expect(screen.getByRole('switch', { name: 'Push notifications' })).toBeChecked();
  });

  it('rolls the toggle back and announces the failure when the save errors', async () => {
    // Hold the PUT open so the optimistic flip is observable before the
    // rejection rolls it back.
    let rejectPut!: (error: Error) => void;
    updatePreferences.mockImplementation(
      () => new Promise<NotificationPreferences>((_, reject) => (rejectPut = reject)),
    );

    renderPage();

    const reminders = await screen.findByRole('switch', { name: 'Booking reminders' });
    expect(reminders).toBeChecked();
    await userEvent.click(reminders);
    expect(reminders).not.toBeChecked();

    rejectPut(new Error('boom'));

    await waitFor(() => expect(reminders).toBeChecked());
    expect(
      await screen.findByText('We could not save that setting. Please try again.'),
    ).toBeInTheDocument();
    // The untouched toggles kept their state through the rollback.
    expect(screen.getByRole('switch', { name: 'Push notifications' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Email notifications' })).not.toBeChecked();
  });

  it('shows a retryable error when the preferences read fails', async () => {
    getPreferences.mockRejectedValue(new Error('boom'));

    renderPage();

    expect(
      await screen.findByText('We could not load your notification settings.'),
    ).toBeInTheDocument();

    getPreferences.mockResolvedValue(INITIAL);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('switch', { name: 'Push notifications' })).toBeChecked();
  });

  it('renders the static sections: version value and coming-soon rows', async () => {
    renderPage();

    await screen.findByRole('switch', { name: 'Push notifications' });
    expect(screen.getByText('Version')).toBeInTheDocument();
    // No destination exists for these yet; they render inert, not as links.
    expect(screen.getByText('Privacy policy')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /privacy policy/i })).not.toBeInTheDocument();
    // Delete my account is a real link into the deletion flow.
    expect(screen.getByRole('link', { name: 'Delete my account' })).toHaveAttribute(
      'href',
      '/account/delete',
    );
  });
});
