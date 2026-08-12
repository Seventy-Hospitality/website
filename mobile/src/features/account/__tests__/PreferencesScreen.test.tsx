import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { api, type NotificationPreferences } from '../../../lib/api';
import { PreferencesScreen } from '../PreferencesScreen';
import { renderWithProviders } from './render-account';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

// Route the preferences read through the live (spied) api at call time; the
// real queryOptions captures api.getPreferences by reference at import, which a
// later spy cannot replace.
jest.mock('../account-data', () => {
  const actual = jest.requireActual('../account-data');
  const { api: liveApi } = require('../../../lib/api');
  return { ...actual, preferencesQuery: { queryKey: ['preferences'], queryFn: () => liveApi.getPreferences() } };
});

let server: NotificationPreferences;

beforeEach(() => {
  jest.restoreAllMocks();
  server = { pushNotifications: false, emailNotifications: true, bookingReminders: true };
  // The refetch that onSettled fires reads the (mutable) server truth.
  jest.spyOn(api, 'getPreferences').mockImplementation(async () => ({ ...server }));
});

describe('PreferencesScreen: optimistic toggle + rollback', () => {
  it('applies the toggle optimistically and rolls it back when the save fails', async () => {
    jest.spyOn(api, 'putPreferences').mockRejectedValue(new Error('network'));

    renderWithProviders(<PreferencesScreen />);
    const push = () => screen.getByLabelText('Push notifications');
    await waitFor(() => expect(push().props.value).toBe(false));

    fireEvent(push(), 'valueChange', true);

    // The optimistic flip sends ONLY the push key...
    await waitFor(() => expect(api.putPreferences).toHaveBeenCalledWith({ pushNotifications: true }));
    // ...then the failed save rolls the push key back to off and toasts an error.
    await waitFor(() => expect(screen.getByText(/could not save that setting/i)).toBeTruthy());
    await waitFor(() => expect(push().props.value).toBe(false));
  });

  it('keeps the confirmed value when the save succeeds', async () => {
    jest.spyOn(api, 'putPreferences').mockImplementation(async (patch) => {
      server = { ...server, ...patch };
      return { ...server };
    });

    renderWithProviders(<PreferencesScreen />);
    const email = () => screen.getByLabelText('Email notifications');
    await waitFor(() => expect(email().props.value).toBe(true));

    await act(async () => {
      fireEvent(email(), 'valueChange', false);
    });

    await waitFor(() => expect(api.putPreferences).toHaveBeenCalledWith({ emailNotifications: false }));
    await waitFor(() => expect(email().props.value).toBe(false));
  });
});
