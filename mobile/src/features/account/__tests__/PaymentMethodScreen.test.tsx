import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { api, type BillingOverview } from '../../../lib/api';
import type { SetupPaymentResult } from '../../../lib/stripe';
import { PaymentMethodScreen } from '../PaymentMethodScreen';
import { renderWithProviders } from './render-account';

const mockBack = jest.fn();
const mockPresent = jest.fn(
  async (): Promise<SetupPaymentResult> => ({ status: 'completed', paymentMethodId: 'pm_new' }),
);
const mockPoll = jest.fn(async (): Promise<SetupPaymentResult> => ({ status: 'processing' }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack, canGoBack: () => true }),
}));

jest.mock('../../../lib/stripe', () => ({
  useSetupPaymentMethod: () => ({ configured: true, present: mockPresent, poll: mockPoll }),
}));

jest.mock('../account-data', () => {
  const actual = jest.requireActual('../account-data');
  const { api: liveApi } = require('../../../lib/api');
  return { ...actual, billingQuery: { queryKey: ['billing'], queryFn: () => liveApi.getBilling() } };
});

const OVERVIEW: BillingOverview = {
  membership: null,
  defaultPaymentMethod: null,
  paymentMethods: [],
  months: [],
};

beforeEach(() => {
  jest.restoreAllMocks();
  mockBack.mockClear();
  mockPresent.mockClear();
  mockPoll.mockClear();
  jest.spyOn(api, 'getBilling').mockResolvedValue(OVERVIEW);
});

describe('PaymentMethodScreen: setup-intent -> set default', () => {
  it('mints a setup intent, saves the card via the sheet, and promotes it to default', async () => {
    const setupSpy = jest.spyOn(api, 'createSetupIntent').mockResolvedValue({
      clientSecret: 'seti_secret',
      customerId: 'cus_1',
      ephemeralKeySecret: 'ek_1',
    });
    const defaultSpy = jest
      .spyOn(api, 'setDefaultPaymentMethod')
      .mockResolvedValue({ default: 'pm_new' });

    renderWithProviders(<PaymentMethodScreen />);

    fireEvent.press(await screen.findByLabelText('Add card'));

    await waitFor(() => expect(setupSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockPresent).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: 'seti_secret' })),
    );
    await waitFor(() => expect(defaultSpy).toHaveBeenCalledWith('pm_new'));
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });
});
