import { MembershipService } from './membership.service';
import { MembershipError, PlanNotFoundError } from '../domain';
import type { MembershipRepository } from '../infrastructure/membership.repository';
import type { PlanRepository } from '../infrastructure/plan.repository';
import type { StripeGateway } from '../infrastructure/stripe.gateway';

function mockMembershipRepo(): MembershipRepository {
  return {
    getByMemberId: vi.fn(),
    upsertBySubscriptionId: vi.fn(),
    updateBySubscriptionId: vi.fn(),
    updateManyBySubscriptionId: vi.fn(),
  } as unknown as MembershipRepository;
}

function mockPlanRepo(): PlanRepository {
  return {
    list: vi.fn(),
    getById: vi.fn(),
    getByStripePriceId: vi.fn(),
  } as unknown as PlanRepository;
}

function mockStripeGateway(): StripeGateway {
  return {
    createCustomer: vi.fn().mockResolvedValue('cus_new'),
    createCheckoutSession: vi.fn().mockResolvedValue('https://checkout.stripe.com/session'),
    createPortalSession: vi.fn().mockResolvedValue('https://billing.stripe.com/session'),
    getActiveSubscription: vi.fn(),
    retrieveSubscription: vi.fn(),
    extractCheckoutData: vi.fn(),
    extractSubscriptionData: vi.fn(),
    extractInvoiceSubscriptionId: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    client: {} as any,
  } as unknown as StripeGateway;
}

const PLAN = {
  id: 'plan_1',
  name: 'Monthly',
  stripePriceId: 'price_123',
  stripeProductId: 'prod_123',
  amountCents: 5000,
  interval: 'month' as const,
  active: true,
};

describe('MembershipService', () => {
  describe('createCheckoutSession', () => {
    it('creates checkout when member has no subscription', async () => {
      const membershipRepo = mockMembershipRepo();
      const planRepo = mockPlanRepo();
      const stripe = mockStripeGateway();

      (planRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(PLAN);
      (membershipRepo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MembershipService(membershipRepo, planRepo, stripe);
      const url = await service.createCheckoutSession('mbr_1', 'plan_1', 'test@test.com', 'John Doe', 'cus_existing');

      expect(url).toBe('https://checkout.stripe.com/session');
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith('cus_existing', 'price_123', 'mbr_1', 'plan_1');
    });

    it('creates Stripe customer if member has none', async () => {
      const membershipRepo = mockMembershipRepo();
      const planRepo = mockPlanRepo();
      const stripe = mockStripeGateway();

      (planRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(PLAN);
      (membershipRepo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MembershipService(membershipRepo, planRepo, stripe);
      await service.createCheckoutSession('mbr_1', 'plan_1', 'test@test.com', 'John Doe', null);

      expect(stripe.createCustomer).toHaveBeenCalledWith('test@test.com', 'John Doe', 'mbr_1');
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith('cus_new', 'price_123', 'mbr_1', 'plan_1');
    });

    it('throws PlanNotFoundError for missing plan', async () => {
      const planRepo = mockPlanRepo();
      (planRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MembershipService(mockMembershipRepo(), planRepo, mockStripeGateway());
      await expect(
        service.createCheckoutSession('mbr_1', 'missing', 'test@test.com', 'John Doe', null)
      ).rejects.toThrow(PlanNotFoundError);
    });

    it('blocks checkout when member has active subscription', async () => {
      const membershipRepo = mockMembershipRepo();
      const planRepo = mockPlanRepo();

      (planRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(PLAN);
      (membershipRepo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'active' });

      const service = new MembershipService(membershipRepo, planRepo, mockStripeGateway());
      await expect(
        service.createCheckoutSession('mbr_1', 'plan_1', 'test@test.com', 'John Doe', 'cus_1')
      ).rejects.toThrow(MembershipError);
    });
  });

  describe('createPortalSession', () => {
    it('creates portal session with customer ID', async () => {
      const stripe = mockStripeGateway();
      const service = new MembershipService(mockMembershipRepo(), mockPlanRepo(), stripe);

      const url = await service.createPortalSession('mbr_1', 'cus_123');
      expect(url).toBe('https://billing.stripe.com/session');
    });

    it('throws when member has no Stripe customer', async () => {
      const service = new MembershipService(mockMembershipRepo(), mockPlanRepo(), mockStripeGateway());
      await expect(service.createPortalSession('mbr_1', null)).rejects.toThrow(MembershipError);
    });
  });

  describe('handleCheckoutCompleted', () => {
    it('upserts membership from checkout data', async () => {
      const membershipRepo = mockMembershipRepo();
      const periodEnd = new Date('2025-12-31');

      const service = new MembershipService(membershipRepo, mockPlanRepo(), mockStripeGateway());
      await service.handleCheckoutCompleted({
        memberId: 'mbr_1',
        planId: 'plan_1',
        subscriptionId: 'sub_1',
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      });

      expect(membershipRepo.upsertBySubscriptionId).toHaveBeenCalledWith('sub_1', {
        memberId: 'mbr_1',
        planId: 'plan_1',
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      });
    });
  });

  describe('handleSubscriptionDeleted', () => {
    it('sets status to canceled', async () => {
      const membershipRepo = mockMembershipRepo();
      const service = new MembershipService(membershipRepo, mockPlanRepo(), mockStripeGateway());

      await service.handleSubscriptionDeleted({ subscriptionId: 'sub_1' });

      expect(membershipRepo.updateBySubscriptionId).toHaveBeenCalledWith('sub_1', { status: 'canceled' });
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    it('sets status to past_due', async () => {
      const membershipRepo = mockMembershipRepo();
      const service = new MembershipService(membershipRepo, mockPlanRepo(), mockStripeGateway());

      await service.handleInvoicePaymentFailed({
        subscriptionId: 'sub_1',
        status: 'past_due',
        currentPeriodEnd: new Date(),
      });

      expect(membershipRepo.updateManyBySubscriptionId).toHaveBeenCalledWith('sub_1', { status: 'past_due' });
    });
  });

  describe('syncFromStripe', () => {
    it('returns null when no Stripe customer', async () => {
      const service = new MembershipService(mockMembershipRepo(), mockPlanRepo(), mockStripeGateway());
      const result = await service.syncFromStripe('mbr_1', null);

      expect(result).toBeNull();
    });

    it('cancels existing membership when Stripe has no active subscription', async () => {
      const membershipRepo = mockMembershipRepo();
      const stripe = mockStripeGateway();

      (stripe.getActiveSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (membershipRepo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue({
        stripeSubscriptionId: 'sub_old',
        status: 'active',
      });

      const service = new MembershipService(membershipRepo, mockPlanRepo(), stripe);
      const result = await service.syncFromStripe('mbr_1', 'cus_123');

      expect(membershipRepo.updateBySubscriptionId).toHaveBeenCalledWith('sub_old', { status: 'canceled' });
      expect(result).toBeNull();
    });

    it('returns null when Stripe has no subscription and no local membership exists', async () => {
      const membershipRepo = mockMembershipRepo();
      const stripe = mockStripeGateway();

      (stripe.getActiveSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (membershipRepo.getByMemberId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MembershipService(membershipRepo, mockPlanRepo(), stripe);
      const result = await service.syncFromStripe('mbr_1', 'cus_123');

      expect(membershipRepo.updateBySubscriptionId).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('upserts membership when Stripe has active subscription with known plan', async () => {
      const membershipRepo = mockMembershipRepo();
      const planRepo = mockPlanRepo();
      const stripe = mockStripeGateway();
      const periodEnd = new Date('2025-12-31');

      (stripe.getActiveSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        subscriptionId: 'sub_1',
        priceId: 'price_123',
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      });
      (planRepo.getByStripePriceId as ReturnType<typeof vi.fn>).mockResolvedValue(PLAN);
      (membershipRepo.upsertBySubscriptionId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem_1' });

      const service = new MembershipService(membershipRepo, planRepo, stripe);
      const result = await service.syncFromStripe('mbr_1', 'cus_123');

      expect(membershipRepo.upsertBySubscriptionId).toHaveBeenCalledWith('sub_1', {
        memberId: 'mbr_1',
        planId: 'plan_1',
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      });
      expect(result).toEqual({ id: 'mem_1' });
    });

    it('returns null when Stripe subscription has unknown price', async () => {
      const membershipRepo = mockMembershipRepo();
      const planRepo = mockPlanRepo();
      const stripe = mockStripeGateway();

      (stripe.getActiveSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        subscriptionId: 'sub_1',
        priceId: 'price_unknown',
        status: 'active',
        currentPeriodEnd: new Date(),
        cancelAtPeriodEnd: false,
      });
      (planRepo.getByStripePriceId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MembershipService(membershipRepo, planRepo, stripe);
      const result = await service.syncFromStripe('mbr_1', 'cus_123');

      expect(membershipRepo.upsertBySubscriptionId).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe('handleSubscriptionUpdated', () => {
    it('updates status and period fields', async () => {
      const membershipRepo = mockMembershipRepo();
      const periodEnd = new Date('2025-12-31');

      const service = new MembershipService(membershipRepo, mockPlanRepo(), mockStripeGateway());
      await service.handleSubscriptionUpdated({
        subscriptionId: 'sub_1',
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
        priceId: null,
      });

      expect(membershipRepo.updateBySubscriptionId).toHaveBeenCalledWith('sub_1', {
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
      });
    });

    it('resolves plan and includes planId when priceId is present', async () => {
      const membershipRepo = mockMembershipRepo();
      const planRepo = mockPlanRepo();
      const periodEnd = new Date('2025-12-31');

      (planRepo.getByStripePriceId as ReturnType<typeof vi.fn>).mockResolvedValue(PLAN);

      const service = new MembershipService(membershipRepo, planRepo, mockStripeGateway());
      await service.handleSubscriptionUpdated({
        subscriptionId: 'sub_1',
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        priceId: 'price_123',
      });

      expect(planRepo.getByStripePriceId).toHaveBeenCalledWith('price_123');
      expect(membershipRepo.updateBySubscriptionId).toHaveBeenCalledWith('sub_1', {
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        planId: 'plan_1',
      });
    });

    it('omits planId when priceId resolves to unknown plan', async () => {
      const membershipRepo = mockMembershipRepo();
      const planRepo = mockPlanRepo();
      const periodEnd = new Date('2025-12-31');

      (planRepo.getByStripePriceId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const service = new MembershipService(membershipRepo, planRepo, mockStripeGateway());
      await service.handleSubscriptionUpdated({
        subscriptionId: 'sub_1',
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        priceId: 'price_unknown',
      });

      expect(membershipRepo.updateBySubscriptionId).toHaveBeenCalledWith('sub_1', {
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      });
    });
  });

  describe('handleInvoicePaid', () => {
    it('updates status and period end for the subscription', async () => {
      const membershipRepo = mockMembershipRepo();
      const periodEnd = new Date('2026-01-31');

      const service = new MembershipService(membershipRepo, mockPlanRepo(), mockStripeGateway());
      await service.handleInvoicePaid({
        subscriptionId: 'sub_1',
        status: 'active',
        currentPeriodEnd: periodEnd,
      });

      expect(membershipRepo.updateManyBySubscriptionId).toHaveBeenCalledWith('sub_1', {
        status: 'active',
        currentPeriodEnd: periodEnd,
      });
    });
  });
});
