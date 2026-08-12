import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { api, type BillingOverview, type BillingTransaction } from '../../../lib/api';
import { BillingScreen } from '../BillingScreen';
import { renderWithProviders } from './render-account';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

jest.mock('../../reserve', () => ({ useVenueTimezone: () => 'UTC' }));

// Route the billing reads through the live (spied) api at call time.
jest.mock('../account-data', () => {
  const actual = jest.requireActual('../account-data');
  const { api: liveApi } = require('../../../lib/api');
  return {
    ...actual,
    billingQuery: { queryKey: ['billing'], queryFn: () => liveApi.getBilling() },
    billingTransactionsQuery: (month: string) => ({
      queryKey: ['billing', 'transactions', month],
      queryFn: () => liveApi.getBillingTransactions(month),
    }),
  };
});

const OVERVIEW: BillingOverview = {
  membership: {
    id: 'sub_1',
    status: 'active',
    currentPeriodEnd: '2027-03-12T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    plan: { id: 'p_month', name: 'Monthly Membership', amountCents: 5000, interval: 'month', tier: 'member' },
    pendingPlan: null,
    pendingPlanEffectiveAt: null,
  },
  defaultPaymentMethod: { id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 9, expYear: 2027, isDefault: true },
  paymentMethods: [],
  months: [{ month: '2026-07', debitCents: 19200, creditCents: 0, netCents: 19200, count: 5 }],
};

const TXN: BillingTransaction = {
  id: 'txn_1',
  kind: 'membership_fee',
  direction: 'debit',
  amountCents: 5000,
  taxCents: 0,
  currency: 'usd',
  status: 'succeeded',
  occurredAt: '2026-07-03T12:00:00.000Z',
  description: 'Monthly membership fee',
  receiptUrl: null,
  reservationId: null,
};

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(api, 'getBilling').mockResolvedValue(OVERVIEW);
});

describe('BillingScreen: month expand + lazy transaction load', () => {
  it('does not load a month until it is expanded, then fetches and shows its rows', async () => {
    const txnSpy = jest
      .spyOn(api, 'getBillingTransactions')
      .mockResolvedValue({ month: '2026-07', transactions: [TXN] });

    renderWithProviders(<BillingScreen />);

    // Membership card + month header render from the overview; transactions are
    // NOT fetched yet.
    await waitFor(() => expect(screen.getByText('July 2026')).toBeTruthy());
    expect(screen.getByText('Monthly Membership')).toBeTruthy();
    expect(screen.getByText('Renews Mar 12, 2027')).toBeTruthy();
    expect(txnSpy).not.toHaveBeenCalled();

    // Expand the month -> lazy fetch that month, then show its transaction row.
    fireEvent.press(screen.getByLabelText('July 2026, 5 transactions · $192'));

    await waitFor(() => expect(txnSpy).toHaveBeenCalledWith('2026-07'));
    await waitFor(() => expect(screen.getByText('Monthly membership fee')).toBeTruthy());
  });
});
