import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ApiError, api, type AuthIdentities } from '../../../lib/api';
import { DeleteAccountScreen } from '../DeleteAccountScreen';
import { renderWithProviders } from './render-account';

const mockReplace = jest.fn();
const mockSignOut = jest.fn(async () => {});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn(), canGoBack: () => true }),
}));

jest.mock('../../../lib/session', () => ({
  useSession: () => ({ principal: { email: 'alice@example.com' }, signOut: mockSignOut }),
}));

jest.mock('../account-data', () => {
  const actual = jest.requireActual('../account-data');
  const { api: liveApi } = require('../../../lib/api');
  return {
    ...actual,
    authIdentitiesQuery: { queryKey: ['auth-identities'], queryFn: () => liveApi.getAuthIdentities() },
  };
});

const PASSWORD_ACCOUNT: AuthIdentities = { hasPassword: true, identities: [] };

beforeEach(() => {
  jest.restoreAllMocks();
  mockReplace.mockClear();
  mockSignOut.mockClear();
  jest.spyOn(api, 'getAuthIdentities').mockResolvedValue(PASSWORD_ACCOUNT);
});

describe('DeleteAccountScreen: step-up gating', () => {
  it('gates deletion behind proof: disabled with no password, then a two-step confirm', async () => {
    const deleteSpy = jest.spyOn(api, 'deleteAccount').mockResolvedValue({ status: 'completed' });

    renderWithProviders(<DeleteAccountScreen />);

    // With no password entered, the delete button is disabled and no request runs.
    const deleteButton = await screen.findByLabelText('Delete my account');
    expect(deleteButton.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(deleteButton);
    expect(screen.queryByLabelText('Permanently delete my account')).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();

    // Enter the password -> the destructive confirm opens; only then does it delete.
    fireEvent.changeText(screen.getByLabelText('Current password'), 'hunter2');
    fireEvent.press(screen.getByLabelText('Delete my account'));

    const confirm = await screen.findByLabelText('Permanently delete my account');
    fireEvent.press(confirm);

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith({ password: 'hunter2' }));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/sign-in'));
  });

  it('surfaces the blocked state (open dispute) instead of deleting', async () => {
    jest
      .spyOn(api, 'deleteAccount')
      .mockRejectedValue(
        new ApiError('DELETION_BLOCKED', 'Account deletion is blocked', 409, {
          reasons: ['an open payment dispute'],
        }),
      );

    renderWithProviders(<DeleteAccountScreen />);

    fireEvent.changeText(await screen.findByLabelText('Current password'), 'hunter2');
    fireEvent.press(screen.getByLabelText('Delete my account'));
    fireEvent.press(await screen.findByLabelText('Permanently delete my account'));

    await waitFor(() =>
      expect(screen.getByText(/Deletion is blocked by an open payment dispute/i)).toBeTruthy(),
    );
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
