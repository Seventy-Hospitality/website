import type { FastifyInstance } from 'fastify';
import { memberService, membershipService } from '@/lib/container';
import { createCheckoutSchema, createPortalSchema } from '@/src/lib/validation';
import { success, error } from '@/src/lib/responses';
import { MemberNotFoundError } from '@/lib/contexts/members';
import { MembershipError, PlanNotFoundError } from '@/lib/contexts/memberships';

export async function stripeRoutes(app: FastifyInstance) {
  // Create checkout session
  app.post('/create-checkout-session', async (req, reply) => {
    const parsed = createCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const member = await memberService.getById(parsed.data.memberId);
      const url = await membershipService.createCheckoutSession(
        member.id,
        parsed.data.planId,
        member.email,
        `${member.firstName} ${member.lastName}`,
        member.stripeCustomerId,
      );
      return success(reply, { url });
    } catch (e) {
      if (e instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      if (e instanceof PlanNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      if (e instanceof MembershipError) return error(reply, 'MEMBERSHIP_ERROR', e.message, 400);
      throw e;
    }
  });

  // Create portal session
  app.post('/create-portal-session', async (req, reply) => {
    const parsed = createPortalSchema.safeParse(req.body);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    try {
      const member = await memberService.getById(parsed.data.memberId);
      const url = await membershipService.createPortalSession(member.id, member.stripeCustomerId);
      return success(reply, { url });
    } catch (e) {
      if (e instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      if (e instanceof MembershipError) return error(reply, 'MEMBERSHIP_ERROR', e.message, 400);
      throw e;
    }
  });

  // Sync member from Stripe
  app.post<{ Params: { id: string } }>('/sync-member/:id', async (req, reply) => {
    try {
      const member = await memberService.getById(req.params.id);
      const membership = await membershipService.syncFromStripe(member.id, member.stripeCustomerId);
      return success(reply, membership);
    } catch (e) {
      if (e instanceof MemberNotFoundError) return error(reply, 'NOT_FOUND', e.message, 404);
      throw e;
    }
  });
}
