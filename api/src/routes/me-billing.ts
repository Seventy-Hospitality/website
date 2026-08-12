import type { FastifyInstance, FastifyRequest } from 'fastify';
import { billingService, membershipService, paymentService } from '@/lib/container';
import { PaymentMethodNotFoundError, type BillingTransaction } from '@/lib/contexts/billing';
import type { PaymentMethodRecord } from '@/lib/contexts/billing';
import { error, success } from '@/src/lib/responses';
import { billingTransactionsQuerySchema } from '@/src/lib/validation';

function memberId(req: FastifyRequest): string {
  return req.principal!.memberId!;
}

function serializePaymentMethod(pm: PaymentMethodRecord | null) {
  if (!pm) return null;
  return {
    id: pm.stripePaymentMethodId,
    brand: pm.brand,
    last4: pm.last4,
    expMonth: pm.expMonth,
    expYear: pm.expYear,
    isDefault: pm.isDefault,
  };
}

function serializeTransaction(row: BillingTransaction) {
  return {
    id: row.id,
    kind: row.kind,
    direction: row.direction,
    amountCents: row.amountCents,
    taxCents: row.taxCents,
    currency: row.currency,
    status: row.status,
    occurredAt: row.occurredAt.toISOString(),
    description: row.description,
    receiptUrl: row.receiptUrl,
    reservationId: row.reservationId,
  };
}

/**
 * Billing screen reads (always the LOCAL ledger, never a live Stripe
 * fan-out) and payment-method management. Ownership is the principal: the
 * member id never comes from the request.
 */
export async function meBillingRoutes(app: FastifyInstance) {
  app.get('/billing', { config: { policy: 'member' } }, async (req, reply) => {
    const [overview, membership, paymentMethods] = await Promise.all([
      billingService.getOverview(memberId(req)),
      membershipService.getOverview(memberId(req)),
      paymentService.listPaymentMethods(memberId(req)),
    ]);

    return success(reply, {
      membership: membership.membership
        ? {
            id: membership.membership.id,
            status: membership.membership.status,
            currentPeriodEnd: membership.membership.currentPeriodEnd.toISOString(),
            cancelAtPeriodEnd: membership.membership.cancelAtPeriodEnd,
            plan: membership.plan
              ? {
                  id: membership.plan.id,
                  name: membership.plan.name,
                  amountCents: membership.plan.amountCents,
                  interval: membership.plan.interval,
                  tier: membership.plan.tier,
                }
              : null,
            pendingPlan: membership.pendingPlan
              ? { id: membership.pendingPlan.id, name: membership.pendingPlan.name }
              : null,
            pendingPlanEffectiveAt:
              membership.membership.pendingPlanEffectiveAt?.toISOString() ?? null,
          }
        : null,
      defaultPaymentMethod: serializePaymentMethod(overview.defaultPaymentMethod),
      paymentMethods: paymentMethods.map((pm) => serializePaymentMethod(pm)),
      months: overview.months,
    });
  });

  app.get('/billing/transactions', { config: { policy: 'member' } }, async (req, reply) => {
    const parsed = billingTransactionsQuerySchema.safeParse(req.query);
    if (!parsed.success) return error(reply, 'VALIDATION_ERROR', parsed.error.message);

    const rows = await billingService.getTransactionsForMonth(memberId(req), parsed.data.month);
    return success(reply, {
      month: parsed.data.month,
      transactions: rows.map(serializeTransaction),
    });
  });

  // "Edit payment method": PaymentSheet setup mode.
  app.post('/payment-methods/setup-intent', { config: { policy: 'member' } }, async (req, reply) => {
    try {
      const result = await paymentService.createSetupIntent(memberId(req));
      return success(reply, result);
    } catch (err) {
      if (err instanceof PaymentMethodNotFoundError) {
        return error(reply, 'NOT_FOUND', 'Member not found', 404);
      }
      throw err;
    }
  });

  // Default on BOTH customer.invoice_settings AND the live subscription;
  // a pm_ id not owned by the caller's own Stripe customer 404s.
  app.post<{ Params: { id: string } }>(
    '/payment-methods/:id/default',
    { config: { policy: 'member' } },
    async (req, reply) => {
      try {
        await paymentService.setDefaultPaymentMethod(memberId(req), req.params.id);
        return success(reply, { default: req.params.id });
      } catch (err) {
        if (err instanceof PaymentMethodNotFoundError) {
          return error(reply, 'NOT_FOUND', 'Payment method not found', 404);
        }
        throw err;
      }
    },
  );
}
