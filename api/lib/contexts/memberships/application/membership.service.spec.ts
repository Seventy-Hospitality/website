import { MembershipService } from './membership.service';
import {
  MembershipError,
  NoMembershipError,
  PlanInviteOnlyError,
  PlanNotFoundError,
  type Membership,
  type Plan,
  type SubscriptionSnapshot,
} from '../domain';
import type { MembershipRepository } from '../infrastructure/membership.repository';
import type { PlanRepository } from '../infrastructure/plan.repository';
import type { SubscriptionGateway } from './ports';

const FETCHED = new Date('2026-08-10T12:00:00Z');
const PERIOD_END = new Date('2026-09-10T12:00:00Z');

const MONTHLY: Plan = {
  id: 'plan_m',
  name: 'Monthly',
  stripePriceId: 'price_m',
  stripeProductId: 'prod_1',
  amountCents: 5000,
  interval: 'month',
  tier: 'member',
  inviteOnly: false,
  features: [],
  sortOrder: 0,
  active: true,
};

const ANNUAL: Plan = { ...MONTHLY, id: 'plan_a', stripePriceId: 'price_a', interval: 'year', amountCents: 48000 };
const PRO: Plan = { ...ANNUAL, id: 'plan_p', stripePriceId: 'price_p', tier: 'pro', amountCents: 96000, inviteOnly: true };

function snapshot(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    subscriptionId: 'sub_1',
    status: 'incomplete',
    rawStatus: 'incomplete',
    statusRecognized: true,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    priceId: 'price_m',
    customerId: 'cus_1',
    memberId: 'mem_1',
    scheduleId: null,
    fetchedAt: FETCHED,
    ...overrides,
  };
}

function membershipRow(overrides: Partial<Membership> = {}): Membership {
  return {
    id: 'ms_1',
    memberId: 'mem_1',
    planId: 'plan_m',
    stripeSubscriptionId: 'sub_1',
    status: 'active',
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    stripeScheduleId: null,
    pendingPlanId: null,
    pendingPlanEffectiveAt: null,
    stripeFetchedAt: FETCHED,
    createdAt: FETCHED,
    updatedAt: FETCHED,
    ...overrides,
  };
}

function mockMembershipRepo(overrides: Record<string, unknown> = {}): MembershipRepository {
  return {
    getCurrentForMember: vi.fn().mockResolvedValue(null),
    getByStripeSubscriptionId: vi.fn().mockResolvedValue(null),
    applySnapshot: vi.fn().mockResolvedValue('updated'),
    setPendingDowngrade: vi.fn(),
    clearPendingDowngrade: vi.fn(),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as MembershipRepository;
}

function mockPlanRepo(plans: Plan[] = [MONTHLY, ANNUAL, PRO]): PlanRepository {
  return {
    list: vi.fn().mockResolvedValue(plans),
    getById: vi.fn(async (id: string) => plans.find((p) => p.id === id) ?? null),
    getByStripePriceId: vi.fn(async (priceId: string) => plans.find((p) => p.stripePriceId === priceId) ?? null),
  } as unknown as PlanRepository;
}

function mockGateway(overrides: Record<string, unknown> = {}): SubscriptionGateway {
  return {
    createCustomer: vi.fn().mockResolvedValue('cus_new'),
    createIncompleteSubscription: vi
      .fn()
      .mockResolvedValue({ snapshot: snapshot(), clientSecret: 'cs_secret' }),
    getConfirmationSecret: vi.fn().mockResolvedValue('cs_fresh'),
    getSubscriptionState: vi.fn().mockResolvedValue(snapshot({ status: 'active', rawStatus: 'active' })),
    changeSubscriptionPrice: vi
      .fn()
      .mockResolvedValue({ snapshot: snapshot({ status: 'active', priceId: 'price_a' }), clientSecret: null }),
    scheduleDowngrade: vi.fn().mockResolvedValue({ scheduleId: 'sched_1', effectiveAt: PERIOD_END }),
    releaseSchedule: vi.fn(),
    setCancelAtPeriodEnd: vi
      .fn()
      .mockResolvedValue(snapshot({ status: 'active', rawStatus: 'active', cancelAtPeriodEnd: true })),
    cancelSubscriptionNow: vi.fn().mockResolvedValue(snapshot({ status: 'canceled', rawStatus: 'canceled' })),
    listAllSubscriptions: vi.fn().mockResolvedValue([]),
    createEphemeralKey: vi.fn().mockResolvedValue('ek_secret'),
    createCheckoutSession: vi.fn().mockResolvedValue('https://checkout.stripe.com/session'),
    createPortalSession: vi.fn().mockResolvedValue('https://billing.stripe.com/session'),
    ...overrides,
  } as unknown as SubscriptionGateway;
}

const termsRecorder = { recordAcceptance: vi.fn() };
const memberLookup = { findByStripeCustomerId: vi.fn().mockResolvedValue({ id: 'mem_1' }) };

function service(deps: {
  membershipRepo?: MembershipRepository;
  planRepo?: PlanRepository;
  gateway?: SubscriptionGateway;
} = {}) {
  return new MembershipService(
    deps.membershipRepo ?? mockMembershipRepo(),
    deps.planRepo ?? mockPlanRepo(),
    deps.gateway ?? mockGateway(),
    termsRecorder,
    memberLookup,
  );
}

const SUBSCRIBE_INPUT = {
  memberId: 'mem_1',
  userId: 'usr_1',
  email: 'alice@example.com',
  name: 'Alice Chen',
  stripeCustomerId: 'cus_1',
  planId: 'plan_m',
  termsVersion: '2026-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  memberLookup.findByStripeCustomerId.mockResolvedValue({ id: 'mem_1' });
});

describe('MembershipService.subscribe', () => {
  it('creates a default_incomplete subscription, records terms server-side, applies the snapshot and returns the sheet payload', async () => {
    const membershipRepo = mockMembershipRepo();
    const gateway = mockGateway();
    const result = await service({ membershipRepo, gateway }).subscribe(SUBSCRIBE_INPUT);

    expect(termsRecorder.recordAcceptance).toHaveBeenCalledWith('usr_1', '2026-01', expect.any(Date));
    expect(gateway.createIncompleteSubscription).toHaveBeenCalledWith({
      customerId: 'cus_1',
      priceId: 'price_m',
      memberId: 'mem_1',
      planId: 'plan_m',
      termsVersion: '2026-01',
    });
    expect(membershipRepo.applySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_1', status: 'incomplete' }),
    );
    expect(result).toMatchObject({
      subscriptionId: 'sub_1',
      clientSecret: 'cs_secret',
      customerId: 'cus_1',
      ephemeralKeySecret: 'ek_secret',
      newStripeCustomerId: null,
    });
  });

  it('creates a Stripe customer for a first-time member and reports it for persistence', async () => {
    const gateway = mockGateway();
    const result = await service({ gateway }).subscribe({ ...SUBSCRIBE_INPUT, stripeCustomerId: null });

    expect(gateway.createCustomer).toHaveBeenCalledWith('alice@example.com', 'Alice Chen', 'mem_1');
    expect(result.newStripeCustomerId).toBe('cus_new');
  });

  it('blocks a second subscription while one is entitled or collecting', async () => {
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow({ status: 'active' })),
    });
    await expect(service({ membershipRepo }).subscribe(SUBSCRIBE_INPUT)).rejects.toThrow(MembershipError);
  });

  it('blocks invite-only plans until an invite mechanism exists', async () => {
    await expect(service().subscribe({ ...SUBSCRIBE_INPUT, planId: 'plan_p' })).rejects.toThrow(
      PlanInviteOnlyError,
    );
  });

  it('throws for a missing or inactive plan', async () => {
    await expect(service().subscribe({ ...SUBSCRIBE_INPUT, planId: 'nope' })).rejects.toThrow(PlanNotFoundError);
  });

  it('re-enters an in-flight incomplete purchase of the same plan with a fresh confirmation secret (no orphan subscriptions)', async () => {
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow({ status: 'incomplete' })),
    });
    const gateway = mockGateway();
    const result = await service({ membershipRepo, gateway }).subscribe(SUBSCRIBE_INPUT);

    expect(result.subscriptionId).toBe('sub_1');
    expect(result.clientSecret).toBe('cs_fresh');
    expect(gateway.createIncompleteSubscription).not.toHaveBeenCalled();
  });

  it('voids an abandoned incomplete purchase of a DIFFERENT plan before creating the new one', async () => {
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi
        .fn()
        .mockResolvedValue(membershipRow({ status: 'incomplete', planId: 'plan_a', stripeSubscriptionId: 'sub_old' })),
    });
    const gateway = mockGateway();
    await service({ membershipRepo, gateway }).subscribe(SUBSCRIBE_INPUT);

    expect(gateway.cancelSubscriptionNow).toHaveBeenCalledWith('sub_old');
    expect(gateway.createIncompleteSubscription).toHaveBeenCalled();
  });
});

describe('MembershipService.confirmSubscription', () => {
  it('re-fetches the subscription and applies fresh state through the same path as the webhook', async () => {
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow({ status: 'incomplete' })),
      getByStripeSubscriptionId: vi.fn().mockResolvedValue(membershipRow({ status: 'active' })),
    });
    const gateway = mockGateway();
    const result = await service({ membershipRepo, gateway }).confirmSubscription('mem_1');

    expect(gateway.getSubscriptionState).toHaveBeenCalledWith('sub_1');
    expect(membershipRepo.applySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_1', status: 'active', fetchedAt: FETCHED }),
    );
    expect(result.activated).toBe(false); // overview re-read comes from getCurrentForMember mock
  });

  it('is idempotent with the webhook: a second confirm simply re-applies fresh state', async () => {
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow({ status: 'active' })),
      getByStripeSubscriptionId: vi.fn().mockResolvedValue(membershipRow({ status: 'active' })),
    });
    const svc = service({ membershipRepo });
    const first = await svc.confirmSubscription('mem_1');
    const second = await svc.confirmSubscription('mem_1');
    expect(first.activated).toBe(true);
    expect(second.activated).toBe(true);
  });

  it('throws NoMembershipError with nothing to confirm', async () => {
    await expect(service().confirmSubscription('mem_1')).rejects.toThrow(NoMembershipError);
  });
});

describe('MembershipService.applySnapshot', () => {
  it('alerts and applies nothing for a dashboard price not in membership_plans', async () => {
    const membershipRepo = mockMembershipRepo();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await service({ membershipRepo }).applySnapshot(
      snapshot({ priceId: 'price_unknown', status: 'active' }),
    );

    expect(result).toEqual({ applied: false, outcome: 'skip_unknown_plan' });
    expect(membershipRepo.applySnapshot).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown price'));
    errorSpy.mockRestore();
  });

  it('never resurrects a dead subscription it has no row for', async () => {
    const membershipRepo = mockMembershipRepo();
    const result = await service({ membershipRepo }).applySnapshot(
      snapshot({ status: 'canceled', rawStatus: 'canceled' }),
    );
    expect(result.outcome).toBe('skip_dead');
    expect(membershipRepo.applySnapshot).not.toHaveBeenCalled();
  });

  it('resolves the member via metadata, then customer lookup, then the fallback', async () => {
    const membershipRepo = mockMembershipRepo();
    memberLookup.findByStripeCustomerId.mockResolvedValue({ id: 'mem_via_customer' });
    await service({ membershipRepo }).applySnapshot(snapshot({ status: 'active', memberId: null }));
    expect(membershipRepo.applySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'mem_via_customer' }),
    );
  });

  it('reports a stale (out-of-order) apply without writing', async () => {
    const membershipRepo = mockMembershipRepo({ applySnapshot: vi.fn().mockResolvedValue('stale') });
    const result = await service({ membershipRepo }).applySnapshot(snapshot({ status: 'active' }));
    expect(result.applied).toBe(false);
    expect(result.outcome).toBe('stale');
  });
});

describe('MembershipService.changePlan', () => {
  function activeRepo(overrides: Partial<Membership> = {}) {
    return mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow(overrides)),
      getByStripeSubscriptionId: vi.fn().mockResolvedValue(membershipRow(overrides)),
    });
  }

  it('upgrades monthly -> annual immediately with prorations', async () => {
    const gateway = mockGateway();
    const membershipRepo = activeRepo();
    const result = await service({ membershipRepo, gateway }).changePlan('mem_1', 'plan_a');

    expect(gateway.changeSubscriptionPrice).toHaveBeenCalledWith('sub_1', 'price_a');
    expect(gateway.scheduleDowngrade).not.toHaveBeenCalled();
    expect(result.kind).toBe('upgraded');
  });

  it('downgrades annual -> monthly at period end via a transient schedule, no refund', async () => {
    const gateway = mockGateway();
    const membershipRepo = activeRepo({ planId: 'plan_a' });
    const result = await service({ membershipRepo, gateway }).changePlan('mem_1', 'plan_m');

    expect(gateway.scheduleDowngrade).toHaveBeenCalledWith('sub_1', 'price_m', 'month');
    expect(gateway.changeSubscriptionPrice).not.toHaveBeenCalled();
    expect(membershipRepo.setPendingDowngrade).toHaveBeenCalledWith('sub_1', {
      scheduleId: 'sched_1',
      pendingPlanId: 'plan_m',
      effectiveAt: PERIOD_END,
    });
    expect(result).toMatchObject({ kind: 'downgrade_scheduled', pendingPlanEffectiveAt: PERIOD_END });
  });

  it('releases an attached schedule BEFORE an upgrade (a stale phase 2 must not revert it)', async () => {
    const gateway = mockGateway();
    const membershipRepo = activeRepo({ stripeScheduleId: 'sched_old', pendingPlanId: 'plan_m' });
    await service({ membershipRepo, gateway }).changePlan('mem_1', 'plan_a');

    expect(gateway.releaseSchedule).toHaveBeenCalledWith('sched_old');
    expect(membershipRepo.clearPendingDowngrade).toHaveBeenCalledWith('sub_1');
    expect(gateway.changeSubscriptionPrice).toHaveBeenCalled();
  });

  it('reverting a pending downgrade back to the current plan just releases the schedule', async () => {
    const gateway = mockGateway();
    const membershipRepo = activeRepo({ stripeScheduleId: 'sched_old', pendingPlanId: 'plan_a' });
    const result = await service({ membershipRepo, gateway }).changePlan('mem_1', 'plan_m');

    expect(gateway.releaseSchedule).toHaveBeenCalledWith('sched_old');
    expect(gateway.changeSubscriptionPrice).not.toHaveBeenCalled();
    expect(gateway.scheduleDowngrade).not.toHaveBeenCalled();
    expect(result.kind).toBe('upgraded');
  });

  it('rejects a change to the plan already held', async () => {
    await expect(service({ membershipRepo: activeRepo() }).changePlan('mem_1', 'plan_m')).rejects.toThrow(
      MembershipError,
    );
  });

  it('blocks invite-only targets', async () => {
    await expect(service({ membershipRepo: activeRepo() }).changePlan('mem_1', 'plan_p')).rejects.toThrow(
      PlanInviteOnlyError,
    );
  });
});

describe('MembershipService.cancelMembership', () => {
  it('defaults to cancel at period end', async () => {
    const gateway = mockGateway();
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow()),
      getByStripeSubscriptionId: vi.fn().mockResolvedValue(membershipRow()),
    });
    const result = await service({ membershipRepo, gateway }).cancelMembership('mem_1');

    expect(gateway.setCancelAtPeriodEnd).toHaveBeenCalledWith('sub_1', true);
    expect(gateway.cancelSubscriptionNow).not.toHaveBeenCalled();
    expect(result).toEqual({ canceledImmediately: false, effectiveAt: PERIOD_END });
  });

  it('cancels immediately with the explicit now flag', async () => {
    const gateway = mockGateway();
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow()),
      getByStripeSubscriptionId: vi.fn().mockResolvedValue(membershipRow({ status: 'canceled' })),
    });
    const result = await service({ membershipRepo, gateway }).cancelMembership('mem_1', { now: true });

    expect(gateway.cancelSubscriptionNow).toHaveBeenCalledWith('sub_1');
    expect(result.canceledImmediately).toBe(true);
  });

  it('releases an attached schedule FIRST (schedule.cancel would kill the subscription immediately)', async () => {
    const gateway = mockGateway();
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow({ stripeScheduleId: 'sched_1' })),
      getByStripeSubscriptionId: vi.fn().mockResolvedValue(membershipRow()),
    });
    await service({ membershipRepo, gateway }).cancelMembership('mem_1');

    expect(gateway.releaseSchedule).toHaveBeenCalledWith('sched_1');
    expect(gateway.setCancelAtPeriodEnd).toHaveBeenCalled();
  });

  it('throws NoMembershipError without a live membership', async () => {
    const membershipRepo = mockMembershipRepo({
      getCurrentForMember: vi.fn().mockResolvedValue(membershipRow({ status: 'canceled' })),
    });
    await expect(service({ membershipRepo }).cancelMembership('mem_1')).rejects.toThrow(NoMembershipError);
  });
});

describe('MembershipService.reconcileSubscriptionDrift', () => {
  it('applies every listed subscription and alerts on local rows missing from the account', async () => {
    const gateway = mockGateway({
      listAllSubscriptions: vi
        .fn()
        .mockResolvedValue([snapshot({ status: 'active' }), snapshot({ subscriptionId: 'sub_2', status: 'past_due' })]),
      getSubscriptionState: vi.fn().mockResolvedValue(null),
    });
    const membershipRepo = mockMembershipRepo({
      getByStripeSubscriptionId: vi.fn().mockResolvedValue(membershipRow()),
      listAll: vi
        .fn()
        .mockResolvedValue([
          { id: 'ms_x', memberId: 'mem_9', stripeSubscriptionId: 'sub_ghost', status: 'active' },
        ]),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await service({ membershipRepo, gateway }).reconcileSubscriptionDrift();

    expect(result.checked).toBe(2);
    expect(result.updated).toBe(2); // the two listed applies; the orphan applies NOTHING
    expect(result.orphanedLocal).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sub_ghost'));
    errorSpy.mockRestore();
  });

  it('NEVER cancels on a wholesale-missing account (test/live key swap): alert-only, zero writes (decision 22)', async () => {
    // A swapped STRIPE_SECRET_KEY makes the listing empty AND every
    // individual retrieve resource_missing. The sweep must not write.
    const gateway = mockGateway({
      listAllSubscriptions: vi.fn().mockResolvedValue([]),
      getSubscriptionState: vi.fn().mockResolvedValue(null),
    });
    const membershipRepo = mockMembershipRepo({
      listAll: vi.fn().mockResolvedValue([
        { id: 'ms_1', memberId: 'mem_1', stripeSubscriptionId: 'sub_live_1', status: 'active' },
        { id: 'ms_2', memberId: 'mem_2', stripeSubscriptionId: 'sub_live_2', status: 'active' },
      ]),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await service({ membershipRepo, gateway }).reconcileSubscriptionDrift();

    expect(result.orphanedLocal).toBe(2);
    expect(result.updated).toBe(0);
    expect(membershipRepo.applySnapshot).not.toHaveBeenCalled(); // the ONLY write path: untouched
    errorSpy.mockRestore();
  });
});

describe('MembershipService.applySubscriptionState on resource_missing', () => {
  it('alerts and applies nothing (a canceled subscription still retrieves; only a key swap 404s)', async () => {
    const gateway = mockGateway({ getSubscriptionState: vi.fn().mockResolvedValue(null) });
    const membershipRepo = mockMembershipRepo();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service({ membershipRepo, gateway }).applySubscriptionState('sub_1');

    expect(result).toEqual({ applied: false, outcome: 'missing' });
    expect(membershipRepo.applySnapshot).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('possible test/live key swap'));
    errorSpy.mockRestore();
  });
});

describe('legacy admin flows', () => {
  it('still creates checkout sessions through the gateway', async () => {
    const gateway = mockGateway();
    const result = await service({ gateway }).createCheckoutSession('mem_1', 'plan_m', 'a@b.c', 'A B', 'cus_1');
    expect(result.url).toContain('checkout.stripe.com');
    expect(gateway.createCheckoutSession).toHaveBeenCalledWith('cus_1', 'price_m', 'mem_1', 'plan_m');
  });

  it('still requires a Stripe customer for the portal', async () => {
    await expect(service().createPortalSession('mem_1', null)).rejects.toThrow(MembershipError);
  });
});
