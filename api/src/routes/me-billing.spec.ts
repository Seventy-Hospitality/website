import type { FastifyInstance } from 'fastify';
import { SessionExpiredError } from '@/lib/contexts/identity';
import { PaymentMethodNotFoundError } from '@/lib/contexts/billing';

const { mockBillingService, mockMembershipService, mockPaymentService, mockMembershipChecker, mockSessionService } =
  vi.hoisted(() => ({
    mockBillingService: {
      getOverview: vi.fn(),
      getTransactionsForMonth: vi.fn().mockResolvedValue([]),
    },
    mockMembershipService: { getOverview: vi.fn() },
    mockPaymentService: {
      createSetupIntent: vi.fn(),
      setDefaultPaymentMethod: vi.fn(),
      listPaymentMethods: vi.fn().mockResolvedValue([]),
    },
    mockMembershipChecker: { hasActiveMembership: vi.fn().mockResolvedValue(true) },
    mockSessionService: { validateAccessToken: vi.fn(), refresh: vi.fn() },
  }));

vi.mock('@/lib/container', () => ({
  billingService: mockBillingService,
  membershipService: mockMembershipService,
  paymentService: mockPaymentService,
  membershipChecker: mockMembershipChecker,
  sessionService: mockSessionService,
}));

import { buildTestApp } from '@/src/test/app';
import { meBillingRoutes } from './me-billing';

const AUTH = { authorization: 'Bearer access_jwt' } as const;

function signedInAs(overrides: Record<string, unknown> = {}) {
  mockSessionService.validateAccessToken.mockResolvedValue({
    userId: 'usr_1',
    sessionId: 'ses_1',
    email: 'alice@example.com',
    emailVerified: true,
    staffRole: null,
    memberId: 'mem_1',
    client: 'member_mobile',
    ...overrides,
  });
}

const PM = {
  id: 'row_1',
  memberId: 'mem_1',
  stripePaymentMethodId: 'pm_1',
  brand: 'visa',
  last4: '4242',
  expMonth: 12,
  expYear: 2030,
  isDefault: true,
};

describe('me-billing routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSessionService.validateAccessToken.mockRejectedValue(new SessionExpiredError());
    mockBillingService.getOverview.mockResolvedValue({
      defaultPaymentMethod: PM,
      months: [{ month: '2026-06', debitCents: 6800, creditCents: 1000, netCents: 5800, count: 3 }],
    });
    mockBillingService.getTransactionsForMonth.mockResolvedValue([]);
    mockMembershipService.getOverview.mockResolvedValue({
      membership: {
        id: 'ms_1',
        status: 'active',
        currentPeriodEnd: new Date('2026-09-10T12:00:00Z'),
        cancelAtPeriodEnd: false,
        pendingPlanEffectiveAt: null,
      },
      plan: { id: 'plan_m', name: 'Monthly', amountCents: 5000, interval: 'month', tier: 'member' },
      pendingPlan: null,
    });
    mockPaymentService.listPaymentMethods.mockResolvedValue([PM]);
    app = await buildTestApp({ routes: meBillingRoutes, prefix: '/api/me' });
  });

  afterEach(() => app.close());

  describe('GET /billing', () => {
    it('requires a member principal', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/me/billing' });
      expect(res.statusCode).toBe(401);
    });

    it('serves membership summary, default card and month buckets from the LOCAL ledger', async () => {
      signedInAs();
      const res = await app.inject({ method: 'GET', url: '/api/me/billing', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockBillingService.getOverview).toHaveBeenCalledWith('mem_1');
      expect(res.json().data).toMatchObject({
        membership: expect.objectContaining({ status: 'active' }),
        defaultPaymentMethod: expect.objectContaining({ id: 'pm_1', brand: 'visa', last4: '4242' }),
        months: [expect.objectContaining({ month: '2026-06', netCents: 5800 })],
      });
    });
  });

  describe('GET /billing/transactions', () => {
    it('requires a valid month parameter', async () => {
      signedInAs();
      const res = await app.inject({ method: 'GET', url: '/api/me/billing/transactions', headers: AUTH });
      expect(res.statusCode).toBe(400);

      const bad = await app.inject({
        method: 'GET',
        url: '/api/me/billing/transactions?month=junk',
        headers: AUTH,
      });
      expect(bad.statusCode).toBe(400);
    });

    it("serves the month's ledger rows for the principal member only", async () => {
      signedInAs();
      mockBillingService.getTransactionsForMonth.mockResolvedValue([
        {
          id: 'bt_1',
          memberId: 'mem_1',
          kind: 'booking_fee',
          direction: 'debit',
          amountCents: 2000,
          taxCents: 0,
          currency: 'usd',
          status: 'succeeded',
          occurredAt: new Date('2026-06-15T18:00:00Z'),
          description: 'Facility booking',
          stripeObjectType: 'charge',
          stripeObjectId: 'ch_1',
          stripeChargeId: 'ch_1',
          receiptUrl: 'https://receipt',
          reservationId: 'rsv_1',
          membershipId: null,
          stripeEventId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/me/billing/transactions?month=2026-06',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(mockBillingService.getTransactionsForMonth).toHaveBeenCalledWith('mem_1', '2026-06');
      expect(res.json().data.transactions[0]).toMatchObject({
        kind: 'booking_fee',
        amountCents: 2000,
        reservationId: 'rsv_1',
      });
      // Raw Stripe internals stay out of the member payload.
      expect(res.json().data.transactions[0].stripeObjectId).toBeUndefined();
    });
  });

  describe('POST /payment-methods/setup-intent', () => {
    it('mints a setup-mode PaymentSheet payload for the principal member', async () => {
      signedInAs();
      mockPaymentService.createSetupIntent.mockResolvedValue({
        clientSecret: 'seti_secret',
        customerId: 'cus_1',
        ephemeralKeySecret: 'ek_secret',
      });

      const res = await app.inject({ method: 'POST', url: '/api/me/payment-methods/setup-intent', headers: AUTH });

      expect(res.statusCode).toBe(200);
      expect(mockPaymentService.createSetupIntent).toHaveBeenCalledWith('mem_1');
      expect(res.json().data).toEqual({
        clientSecret: 'seti_secret',
        customerId: 'cus_1',
        ephemeralKeySecret: 'ek_secret',
      });
    });
  });

  describe('POST /payment-methods/:id/default', () => {
    it('sets the default through the service (which writes BOTH Stripe fields)', async () => {
      signedInAs();
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/payment-methods/pm_1/default',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(mockPaymentService.setDefaultPaymentMethod).toHaveBeenCalledWith('mem_1', 'pm_1');
    });

    it("404s a pm_ id that is not the caller's own (no IDOR)", async () => {
      signedInAs();
      mockPaymentService.setDefaultPaymentMethod.mockRejectedValue(new PaymentMethodNotFoundError());
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/payment-methods/pm_SOMEONE_ELSES/default',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
