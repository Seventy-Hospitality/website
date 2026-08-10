import {
  isPlanUpgrade,
  membershipInvariants,
  resolveSubscriptionApply,
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
import type { MemberAccountLookup, SubscriptionGateway, TermsRecorder } from './ports';

export interface SubscribeResult {
  subscriptionId: string;
  /** latest_invoice.confirmation_secret for PaymentSheet. */
  clientSecret: string | null;
  customerId: string;
  /** Ephemeral key minted at the mobile SDK's API version. */
  ephemeralKeySecret: string;
  /** Set when a Stripe customer was created for the member (persist it). */
  newStripeCustomerId: string | null;
}

export interface ApplyResult {
  applied: boolean;
  outcome: 'created' | 'updated' | 'stale' | 'skip_dead' | 'skip_unknown_plan' | 'skip_no_member' | 'missing';
  membership?: Membership | null;
}

export interface MembershipOverview {
  membership: Membership | null;
  plan: Plan | null;
  pendingPlan: Plan | null;
}

/**
 * Subscription lifecycle. Owns subscription STATE; every Stripe call goes
 * through the SubscriptionGateway port (implemented by the billing
 * context). All webhook/read-back/drift writes converge on
 * applySubscriptionState -> MembershipRepository.applySnapshot, the one
 * guarded write path.
 */
export class MembershipService {
  constructor(
    private readonly membershipRepo: MembershipRepository,
    private readonly planRepo: PlanRepository,
    private readonly gateway: SubscriptionGateway,
    private readonly termsRecorder: TermsRecorder,
    private readonly memberLookup: MemberAccountLookup,
  ) {}

  // ── Purchase (subscription-first) ──

  async subscribe(input: {
    memberId: string;
    userId: string;
    email: string;
    name: string;
    stripeCustomerId: string | null;
    planId: string;
    termsVersion: string;
    now?: Date;
  }): Promise<SubscribeResult> {
    const now = input.now ?? new Date();
    const plan = await this.planRepo.getById(input.planId);
    if (!plan || !plan.active) throw new PlanNotFoundError(input.planId);
    // No invite mechanism exists yet; an invite-only plan cannot be
    // self-served. TODO(package-d): honor club/staff invites here.
    if (plan.inviteOnly) throw new PlanInviteOnlyError();

    const current = await this.membershipRepo.getCurrentForMember(input.memberId);
    membershipInvariants.canStartSubscription(current);

    let customerId = input.stripeCustomerId;
    let newStripeCustomerId: string | null = null;
    if (!customerId) {
      customerId = await this.gateway.createCustomer(input.email, input.name, input.memberId);
      newStripeCustomerId = customerId;
    }

    // Terms are recorded server-side BEFORE the subscription exists; a
    // Stripe failure leaves a harmless acceptance record.
    await this.termsRecorder.recordAcceptance(input.userId, input.termsVersion, now);

    // Re-entry: an in-flight incomplete purchase of the same plan hands
    // back a fresh confirmation secret instead of minting orphan
    // subscriptions on every retry.
    if (current && current.status === 'incomplete') {
      if (current.planId === plan.id) {
        const clientSecret = await this.gateway.getConfirmationSecret(current.stripeSubscriptionId);
        if (clientSecret) {
          return {
            subscriptionId: current.stripeSubscriptionId,
            clientSecret,
            customerId,
            ephemeralKeySecret: await this.gateway.createEphemeralKey(customerId),
            newStripeCustomerId,
          };
        }
      } else {
        // Abandoned incomplete purchase of a different plan: void it so it
        // cannot complete later and stack a second subscription.
        await this.gateway.cancelSubscriptionNow(current.stripeSubscriptionId).catch(() => {});
      }
    }

    const { snapshot, clientSecret } = await this.gateway.createIncompleteSubscription({
      customerId,
      priceId: plan.stripePriceId,
      memberId: input.memberId,
      planId: plan.id,
      termsVersion: input.termsVersion,
    });
    await this.applySnapshot(snapshot, { fallbackMemberId: input.memberId });

    return {
      subscriptionId: snapshot.subscriptionId,
      clientSecret,
      customerId,
      ephemeralKeySecret: await this.gateway.createEphemeralKey(customerId),
      newStripeCustomerId,
    };
  }

  /**
   * Synchronous read-back after PaymentSheet success: re-fetch the
   * subscription and apply fresh state through the same idempotent path the
   * webhook uses. The app cannot wait on a webhook to render "active".
   */
  async confirmSubscription(memberId: string): Promise<MembershipOverview & { activated: boolean }> {
    const current = await this.membershipRepo.getCurrentForMember(memberId);
    if (!current) throw new NoMembershipError();
    await this.applySubscriptionState(current.stripeSubscriptionId, { fallbackMemberId: memberId });
    const overview = await this.getOverview(memberId);
    return { ...overview, activated: overview.membership?.status === 'active' };
  }

  async getOverview(memberId: string): Promise<MembershipOverview> {
    const membership = await this.membershipRepo.getCurrentForMember(memberId);
    if (!membership) return { membership: null, plan: null, pendingPlan: null };
    const [plan, pendingPlan] = await Promise.all([
      this.planRepo.getById(membership.planId),
      membership.pendingPlanId ? this.planRepo.getById(membership.pendingPlanId) : null,
    ]);
    return { membership, plan, pendingPlan };
  }

  // ── Plan changes ──

  /**
   * Upgrades (tier up, monthly -> annual, price up) apply immediately with
   * prorations; downgrades take effect at period end via a transient
   * subscription schedule, no refund (settled policy).
   */
  async changePlan(
    memberId: string,
    targetPlanId: string,
  ): Promise<{
    kind: 'upgraded' | 'downgrade_scheduled';
    clientSecret: string | null;
    pendingPlanEffectiveAt: Date | null;
  }> {
    const membership = await this.membershipRepo.getCurrentForMember(memberId);
    if (!membership) throw new NoMembershipError();
    const currentPlan = await this.planRepo.getById(membership.planId);
    const targetPlan = await this.planRepo.getById(targetPlanId);
    if (!targetPlan || !targetPlan.active) throw new PlanNotFoundError(targetPlanId);
    if (targetPlan.inviteOnly) throw new PlanInviteOnlyError();
    if (!currentPlan) throw new PlanNotFoundError(membership.planId);
    if (targetPlan.id === currentPlan.id && !membership.pendingPlanId) {
      throw new MembershipError('Already on this plan');
    }

    // Any attached schedule must be released first: while attached, direct
    // subscription updates silently split phases, and a stale phase 2 would
    // revert an upgrade at period end.
    if (membership.stripeScheduleId) {
      await this.gateway.releaseSchedule(membership.stripeScheduleId);
      await this.membershipRepo.clearPendingDowngrade(membership.stripeSubscriptionId);
    }
    if (targetPlan.id === currentPlan.id) {
      // Reverting a pending downgrade back to the current plan: releasing
      // the schedule above was the whole change.
      return { kind: 'upgraded', clientSecret: null, pendingPlanEffectiveAt: null };
    }

    if (isPlanUpgrade(currentPlan, targetPlan)) {
      const { snapshot, clientSecret } = await this.gateway.changeSubscriptionPrice(
        membership.stripeSubscriptionId,
        targetPlan.stripePriceId,
      );
      await this.applySnapshot(snapshot, { fallbackMemberId: memberId });
      return { kind: 'upgraded', clientSecret, pendingPlanEffectiveAt: null };
    }

    const { scheduleId, effectiveAt } = await this.gateway.scheduleDowngrade(
      membership.stripeSubscriptionId,
      targetPlan.stripePriceId,
      targetPlan.interval,
    );
    await this.membershipRepo.setPendingDowngrade(membership.stripeSubscriptionId, {
      scheduleId,
      pendingPlanId: targetPlan.id,
      effectiveAt,
    });
    return { kind: 'downgrade_scheduled', clientSecret: null, pendingPlanEffectiveAt: effectiveAt };
  }

  // ── Cancel ──

  /** Default: at period end. `now` cancels immediately with no refund. */
  async cancelMembership(
    memberId: string,
    options: { now?: boolean } = {},
  ): Promise<{ canceledImmediately: boolean; effectiveAt: Date }> {
    const membership = await this.membershipRepo.getCurrentForMember(memberId);
    if (!membership || membership.status === 'canceled' || membership.status === 'incomplete_expired') {
      throw new NoMembershipError();
    }

    // subscriptionSchedules.cancel would kill the subscription immediately;
    // always detach the schedule first, whatever the cancel mode.
    if (membership.stripeScheduleId) {
      await this.gateway.releaseSchedule(membership.stripeScheduleId);
      await this.membershipRepo.clearPendingDowngrade(membership.stripeSubscriptionId);
    }

    const snapshot = options.now
      ? await this.gateway.cancelSubscriptionNow(membership.stripeSubscriptionId)
      : await this.gateway.setCancelAtPeriodEnd(membership.stripeSubscriptionId, true);
    await this.applySnapshot(snapshot, { fallbackMemberId: memberId });

    return {
      canceledImmediately: Boolean(options.now),
      effectiveAt: options.now ? snapshot.fetchedAt : snapshot.currentPeriodEnd,
    };
  }

  // ── Webhook / read-back / drift apply ──

  /**
   * The trigger entry point: re-fetch the subscription, apply fresh state.
   * Idempotent and ordering-safe (fetch-time guard in the repository).
   */
  async applySubscriptionState(
    subscriptionId: string,
    options: { fallbackMemberId?: string } = {},
  ): Promise<ApplyResult> {
    const snapshot = await this.gateway.getSubscriptionState(subscriptionId);
    if (!snapshot) {
      // Stripe no longer knows the id at all (deleted test data or a
      // test/live key swap): terminal locally, loudly.
      const marked = await this.membershipRepo.markCanceledBySubscriptionId(subscriptionId, new Date());
      if (marked) {
        console.error(`[memberships] subscription ${subscriptionId} missing at Stripe; marked canceled`);
      }
      return { applied: marked, outcome: 'missing' };
    }
    return this.applySnapshot(snapshot, options);
  }

  /** Apply an already-fetched snapshot (webhook re-fetch or drift sweep). */
  async applySnapshot(
    snapshot: SubscriptionSnapshot,
    options: { fallbackMemberId?: string } = {},
  ): Promise<ApplyResult> {
    if (!snapshot.statusRecognized) {
      console.error(
        `[memberships] unrecognized subscription status "${snapshot.rawStatus}" on ${snapshot.subscriptionId}; stored fail-closed as "${snapshot.status}"`,
      );
    }

    const plan = snapshot.priceId ? await this.planRepo.getByStripePriceId(snapshot.priceId) : null;
    const existing = await this.membershipRepo.getByStripeSubscriptionId(snapshot.subscriptionId);
    let memberId: string | null = existing?.memberId ?? snapshot.memberId ?? null;
    if (!memberId && snapshot.customerId) {
      memberId = (await this.memberLookup.findByStripeCustomerId(snapshot.customerId))?.id ?? null;
    }
    if (!memberId) memberId = options.fallbackMemberId ?? null;

    const decision = resolveSubscriptionApply({
      snapshot,
      hasExistingRow: existing !== null,
      planId: plan?.id ?? null,
      memberId,
    });

    switch (decision.action) {
      case 'skip_unknown_plan':
        // A dashboard-changed price not in membership_plans must alert,
        // never silently no-op (the old syncFromStripe bug).
        console.error(
          `[memberships] subscription ${snapshot.subscriptionId} uses unknown price ${snapshot.priceId}; state NOT applied`,
        );
        return { applied: false, outcome: 'skip_unknown_plan' };
      case 'skip_no_member':
        console.error(
          `[memberships] no member resolves for subscription ${snapshot.subscriptionId} (customer ${snapshot.customerId}); state NOT applied`,
        );
        return { applied: false, outcome: 'skip_no_member' };
      case 'skip_dead':
        return { applied: false, outcome: 'skip_dead' };
      case 'apply':
        break;
    }

    const outcome = await this.membershipRepo.applySnapshot({
      subscriptionId: snapshot.subscriptionId,
      memberId: memberId!,
      planId: plan!.id,
      status: snapshot.status,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      scheduleId: snapshot.scheduleId,
      fetchedAt: snapshot.fetchedAt,
    });
    return {
      applied: outcome !== 'stale',
      outcome,
      membership: await this.membershipRepo.getByStripeSubscriptionId(snapshot.subscriptionId),
    };
  }

  /**
   * Account-wide drift sweep (replaces the per-member syncFromStripe loop):
   * one subscriptions.list pass applies fresh state everywhere, then local
   * rows whose subscription never appeared are re-checked individually. A
   * local row missing from Stripe entirely suggests a test/live key swap:
   * alerted, never auto-canceled from the list alone.
   */
  async reconcileSubscriptionDrift(): Promise<{
    checked: number;
    updated: number;
    stale: number;
    skipped: number;
    orphanedLocal: number;
  }> {
    const snapshots = await this.gateway.listAllSubscriptions();
    let updated = 0;
    let stale = 0;
    let skipped = 0;

    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      seen.add(snapshot.subscriptionId);
      const result = await this.applySnapshot(snapshot);
      if (result.applied) updated += 1;
      else if (result.outcome === 'stale') stale += 1;
      else skipped += 1;
    }

    let orphanedLocal = 0;
    for (const row of await this.membershipRepo.listAll()) {
      if (seen.has(row.stripeSubscriptionId) || row.status === 'canceled') continue;
      orphanedLocal += 1;
      console.error(
        `[memberships] local membership ${row.id} (subscription ${row.stripeSubscriptionId}) not found in Stripe account listing; possible test/live key swap`,
      );
      const result = await this.applySubscriptionState(row.stripeSubscriptionId);
      if (result.applied) updated += 1;
    }

    return { checked: snapshots.length, updated, stale, skipped, orphanedLocal };
  }

  // ── Legacy admin flows (Checkout redirect + Billing Portal) ──

  async createCheckoutSession(
    memberId: string,
    planId: string,
    memberEmail: string,
    memberName: string,
    stripeCustomerId: string | null,
  ): Promise<{ url: string; newStripeCustomerId: string | null }> {
    const plan = await this.planRepo.getById(planId);
    if (!plan) throw new PlanNotFoundError(planId);

    const currentMembership = await this.membershipRepo.getCurrentForMember(memberId);
    membershipInvariants.canStartSubscription(currentMembership);

    let customerId = stripeCustomerId;
    let newStripeCustomerId: string | null = null;
    if (!customerId) {
      customerId = await this.gateway.createCustomer(memberEmail, memberName, memberId);
      newStripeCustomerId = customerId;
    }

    const url = await this.gateway.createCheckoutSession(customerId, plan.stripePriceId, memberId, planId);
    return { url, newStripeCustomerId };
  }

  async createPortalSession(memberId: string, stripeCustomerId: string | null) {
    membershipInvariants.requiresStripeCustomer(stripeCustomerId);
    return this.gateway.createPortalSession(stripeCustomerId!);
  }
}
