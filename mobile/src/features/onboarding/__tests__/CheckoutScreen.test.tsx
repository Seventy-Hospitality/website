import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import type { Plan } from '../../../lib/api';
import type { PresentPaymentResult } from '../../../lib/stripe';
import { CheckoutScreen } from '../CheckoutScreen';

// mock-prefixed so jest.mock's hoisted factories may reference them.
const mockReplace = jest.fn();
const mockRefresh = jest.fn();
const mockSheet = jest.fn(
  async (): Promise<PresentPaymentResult> => ({ status: 'completed' }),
);

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({ plan: 'plan_x' }),
  Redirect: () => null,
}));

jest.mock('../../../lib/session', () => ({
  useSession: () => ({ refresh: mockRefresh, emailVerified: true }),
}));

jest.mock('../../../lib/stripe', () => ({
  usePaymentsConfigured: () => true,
  usePaymentSheet: () => mockSheet,
}));

// The real queryOptions capture api.getPlans by reference at import time, which
// a later jest.spyOn cannot replace. Re-derive the queryFns to read the live
// (spied) api at CALL time so the beforeEach spies drive the queries.
jest.mock('../queries', () => {
  const { api } = require('../../../lib/api');
  return {
    plansQuery: { queryKey: ['plans'], queryFn: () => api.getPlans() },
    billingQuery: { queryKey: ['billing'], queryFn: () => api.getBilling() },
  };
});

const PLAN: Plan = {
  id: 'plan_x',
  name: 'Standard Member',
  stripePriceId: 'price_x',
  amountCents: 5000,
  interval: 'month',
  tier: 'member',
  inviteOnly: false,
  features: [],
  sortOrder: 1,
  active: true,
};

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<CheckoutScreen />, { wrapper });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockReplace.mockClear();
  mockRefresh.mockReset();
  mockSheet.mockClear();
  jest.spyOn(api, 'getPlans').mockResolvedValue([PLAN]);
  jest.spyOn(api, 'subscribeMembership').mockResolvedValue({
    subscriptionId: 'sub_1',
    clientSecret: 'pi_sub_secret',
    customerId: 'cus_1',
    ephemeralKeySecret: 'ek_1',
  });
});

describe('onboarding CheckoutScreen: activated confirm never strands a paid member', () => {
  it('navigates to the ID step even when refresh() rejects after activation', async () => {
    // First confirm parks in the processing hold; the Check-again confirm
    // activates. refresh() rejects at that instant (transient getMe blip).
    jest
      .spyOn(api, 'confirmMembership')
      .mockResolvedValueOnce({ activated: false, paymentStatus: 'processing', membership: null })
      .mockResolvedValueOnce({ activated: true, paymentStatus: 'succeeded', membership: null });
    mockRefresh.mockRejectedValue(new Error('network blip'));

    renderScreen();

    // Accept the terms, then confirm to run subscribe -> sheet -> confirm.
    fireEvent.press(await screen.findByLabelText('I agree to the Terms and Conditions'));
    fireEvent.press(screen.getByLabelText('Confirm membership'));

    // Parked in the processing hold with a manual re-check.
    const checkAgain = await screen.findByLabelText('Check again');

    // Re-check: activates, refresh() rejects, but navigation must still run.
    fireEvent.press(checkAgain);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/onboarding/verify-identity'),
    );
    expect(mockRefresh).toHaveBeenCalled();
  });
});
