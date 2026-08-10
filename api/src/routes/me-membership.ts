import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { memberRepo, memberService, membershipService } from '@/lib/container';
import { MemberNotFoundError } from '@/lib/contexts/members';
import {
  MembershipError,
  NoMembershipError,
  PlanInviteOnlyError,
  PlanNotFoundError,
  type Membership,
  type MembershipOverview,
  type Plan,
} from '@/lib/contexts/memberships';
import { error, success } from '@/src/lib/responses';
import {
  cancelMembershipQuerySchema,
  changeMembershipSchema,
  subscribeMembershipSchema,
} from '@/src/lib/validation';

function memberId(req: FastifyRequest): string {
  return req.principal!.memberId!;
}

function serializePlan(plan: Plan | null) {
  if (!plan) return null;
  return {
    id: plan.id,
    name: plan.name,
    amountCents: plan.amountCents,
    interval: plan.interval,
    tier: plan.tier,
  };
}

function serializeOverview(overview: MembershipOverview) {
  const membership = overview.membership as Membership | null;
  if (!membership) return null;
  return {
    id: membership.id,
    status: membership.status,
    currentPeriodEnd: membership.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: membership.cancelAtPeriodEnd,
    plan: serializePlan(overview.plan),
    pendingPlan: serializePlan(overview.pendingPlan),
    pendingPlanEffectiveAt: membership.pendingPlanEffectiveAt?.toISOString() ?? null,
  };
}

function handleMembershipError(reply: FastifyReply, err: unknown) {
  if (err instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof PlanNotFoundError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof NoMembershipError) return error(reply, 'NOT_FOUND', err.message, 404);
  if (err instanceof PlanInviteOnlyError) return error(reply, 'INVITE_ONLY', err.message, 403);
  if (err instanceof MembershipError) return error(reply, 'MEMBERSHIP_ERROR', err.message, 409);
  throw err;
}

/**
 * Membership purchase + lifecycle (mobile app). Subscription-first: the
 * subscribe call returns the confirmation secret for PaymentSheet; confirm
 * does the synchronous read-back so the app never waits on a webhook.
 */
export async function meMembershipRoutes(app: FastifyInstance) {
  app.post('/membership/subscribe', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = subscribeMembershipSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const member = await memberService.getById(memberId(req));
      const result = await membershipService.subscribe({
        memberId: member.id,
        userId: req.principal!.userId,
        email: member.email,
        name: `${member.firstName} ${member.lastName}`,
        stripeCustomerId: member.stripeCustomerId,
        planId: parsed.data.planId,
        termsVersion: parsed.data.termsVersion,
      });
      if (result.newStripeCustomerId) {
        await memberRepo.setStripeCustomerId(member.id, result.newStripeCustomerId);
      }
      return success(reply, {
        subscriptionId: result.subscriptionId,
        clientSecret: result.clientSecret,
        customerId: result.customerId,
        ephemeralKeySecret: result.ephemeralKeySecret,
      });
    } catch (err) {
      return handleMembershipError(reply, err);
    }
  });

  app.post('/membership/confirm', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      const result = await membershipService.confirmSubscription(memberId(req));
      return success(reply, {
        activated: result.activated,
        membership: serializeOverview(result),
      });
    } catch (err) {
      return handleMembershipError(reply, err);
    }
  });

  // Tier/period change: upgrades immediate with prorations, downgrades at
  // period end (no refund). Requires a live membership.
  app.post('/membership/change', { config: { policy: 'active-member' } }, async (req, reply) => {
    const parsed = changeMembershipSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const result = await membershipService.changePlan(memberId(req), parsed.data.planId);
      const overview = await membershipService.getOverview(memberId(req));
      return success(reply, {
        kind: result.kind,
        clientSecret: result.clientSecret,
        pendingPlanEffectiveAt: result.pendingPlanEffectiveAt?.toISOString() ?? null,
        membership: serializeOverview(overview),
      });
    } catch (err) {
      return handleMembershipError(reply, err);
    }
  });

  // Cancel: default at period end; ?now=true cancels immediately (no
  // refund). Policy `member`, not `active-member`: a past_due member must
  // still be able to cancel.
  app.delete('/membership', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = cancelMembershipQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const result = await membershipService.cancelMembership(memberId(req), {
        now: parsed.data.now,
      });
      const overview = await membershipService.getOverview(memberId(req));
      return success(reply, {
        canceledImmediately: result.canceledImmediately,
        effectiveAt: result.effectiveAt.toISOString(),
        membership: serializeOverview(overview),
      });
    } catch (err) {
      return handleMembershipError(reply, err);
    }
  });
}
