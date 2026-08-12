import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { PresentPaymentResult } from '../../../lib/stripe';
import { api, type BillingOverview, type Plan } from '../../../lib/api';
import { ChangeMembershipScreen } from '../ChangeMembershipScreen';
import { renderWithProviders } from './render-account';

const mockBack = jest.fn();
const mockSheet = jest.fn(async (): Promise<PresentPaymentResult> => ({ status: 'completed' }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack, canGoBack: () => true }),
}));

jest.mock('../../reserve', () => ({ useVenueTimezone: () => 'UTC' }));

jest.mock('../../../lib/stripe', () => ({
  usePaymentsConfigured: () => true,
  usePaymentSheet: () => mockSheet,
}));

jest.mock('../account-data', () => {
  const actual = jest.requireActual('../account-data');
  const { api: liveApi } = require('../../../lib/api');
  return { ...actual, billingQuery: { queryKey: ['billing'], queryFn: () => liveApi.getBilling() } };
});

jest.mock('../../onboarding/queries', () => {
  const { api: liveApi } = require('../../../lib/api');
  return { plansQuery: { queryKey: ['plans'], queryFn: () => liveApi.getPlans() } };
});

const PLANS: Plan[] = [
  { id: 'p_month', name: 'Monthly Membership', stripePriceId: '', amountCents: 5000, interval: 'month', tier: 'member', inviteOnly: false, features: [], sortOrder: 0, active: true },
  { id: 'p_year', name: 'Annual Membership', stripePriceId: '', amountCents: 48000, interval: 'year', tier: 'member', inviteOnly: false, features: [], sortOrder: 1, active: true },
];

function overviewOn(planId: 'p_month' | 'p_year'): BillingOverview {
  const plan = PLANS.find((p) => p.id === planId)!;
  return {
    membership: {
      id: 'sub_1',
      status: 'active',
      currentPeriodEnd: '2027-03-12T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      plan: { id: plan.id, name: plan.name, amountCents: plan.amountCents, interval: plan.interval, tier: 'member' },
      pendingPlan: null,
      pendingPlanEffectiveAt: null,
    },
    defaultPaymentMethod: null,
    paymentMethods: [],
    months: [],
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockBack.mockClear();
  mockSheet.mockClear();
  jest.spyOn(api, 'getPlans').mockResolvedValue(PLANS);
});

describe('ChangeMembershipScreen', () => {
  it('upgrades: prices the new plan, presents the PaymentSheet, confirms, and returns', async () => {
    jest.spyOn(api, 'getBilling').mockResolvedValue(overviewOn('p_month'));
    const changeSpy = jest.spyOn(api, 'changeMembership').mockResolvedValue({
      kind: 'upgraded',
      clientSecret: 'pi_proration',
      pendingPlanEffectiveAt: null,
      membership: null,
    });
    const confirmSpy = jest
      .spyOn(api, 'confirmMembership')
      .mockResolvedValue({ activated: true, paymentStatus: 'succeeded', membership: null });

    renderWithProviders(<ChangeMembershipScreen />);

    // Switch to the annual period, then pick the annual member plan (an upgrade).
    fireEvent.press(await screen.findByText('Pay annually'));
    fireEvent.press(await screen.findByLabelText('Member membership, $480 / year'));

    fireEvent.press(await screen.findByLabelText('Switch now'));

    await waitFor(() => expect(changeSpy).toHaveBeenCalledWith('p_year'));
    await waitFor(() =>
      expect(mockSheet).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: 'pi_proration' })),
    );
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('downgrades: schedules the change with no payment step and returns', async () => {
    jest.spyOn(api, 'getBilling').mockResolvedValue(overviewOn('p_year'));
    const changeSpy = jest.spyOn(api, 'changeMembership').mockResolvedValue({
      kind: 'downgrade_scheduled',
      clientSecret: null,
      pendingPlanEffectiveAt: '2027-03-12T00:00:00.000Z',
      membership: null,
    });

    renderWithProviders(<ChangeMembershipScreen />);

    // Switch to monthly, then pick the monthly plan (a downgrade from annual).
    fireEvent.press(await screen.findByText('Pay monthly'));
    fireEvent.press(await screen.findByLabelText('Member membership, $50 / month'));

    fireEvent.press(await screen.findByLabelText('Switch on Mar 12, 2027'));

    await waitFor(() => expect(changeSpy).toHaveBeenCalledWith('p_month'));
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    expect(mockSheet).not.toHaveBeenCalled();
  });
});
