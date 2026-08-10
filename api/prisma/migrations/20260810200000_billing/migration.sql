-- Billing bounded context (Club70 app package C).
-- billing_transactions: the member-facing money ledger (one row per Stripe
-- money movement; [stripeObjectType, stripeObjectId] is the idempotency
-- anchor; occurredAt carries Stripe's `created`, not our insert time).
-- payment_methods: local mirror of Stripe payment methods for instant
-- brand+last4 rendering. processed_webhook_events: webhook dedupe.
-- membership_plans grows the app catalog columns (inviteOnly, features,
-- sortOrder); monthly+annual pricing is modeled as one row per Stripe price.
-- reservation_payments gains disputedAt: a disputed charge is frozen out of
-- refundable balance while still counting as captured money.

-- AlterTable
ALTER TABLE "membership_plans" ADD COLUMN "inviteOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- memberships: one row per Stripe subscription. memberId stops being unique
-- (a customer can hold several subscriptions; re-subscribing is a new
-- subscription id), webhook apply becomes a pure upsert by
-- stripeSubscriptionId, and the fetch-time guard column orders concurrent
-- re-fetch-and-apply writers. Schedule columns carry a pending downgrade.
DROP INDEX "memberships_memberId_key";
CREATE INDEX "memberships_memberId_idx" ON "memberships"("memberId");
ALTER TABLE "memberships" ADD COLUMN "stripeScheduleId" TEXT,
ADD COLUMN "pendingPlanId" TEXT,
ADD COLUMN "pendingPlanEffectiveAt" TIMESTAMP(3),
ADD COLUMN "stripeFetchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "reservation_payments" ADD COLUMN "disputedAt" TIMESTAMP(3),
ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'base';

-- Backfill: rows referenced by a pending change are grow deltas.
UPDATE "reservation_payments" SET "purpose" = 'change_delta'
WHERE "id" IN (SELECT "chargePaymentId" FROM "reservation_pending_changes");

-- Idempotency anchor for webhook/reconcile refund ingestion.
CREATE UNIQUE INDEX "reservation_payments_stripeRefundId_key" ON "reservation_payments"("stripeRefundId");

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN "cancelRefundPercent" INTEGER;

-- CreateTable
CREATE TABLE "billing_transactions" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "stripeObjectType" TEXT NOT NULL,
    "stripeObjectId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "receiptUrl" TEXT,
    "reservationId" TEXT,
    "membershipId" TEXT,
    "stripeEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "stripePaymentMethodId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "expMonth" INTEGER NOT NULL,
    "expYear" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_webhook_events" (
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_transactions_stripeObjectType_stripeObjectId_key" ON "billing_transactions"("stripeObjectType", "stripeObjectId");
CREATE INDEX "billing_transactions_memberId_occurredAt_idx" ON "billing_transactions"("memberId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_stripePaymentMethodId_key" ON "payment_methods"("stripePaymentMethodId");
CREATE INDEX "payment_methods_memberId_idx" ON "payment_methods"("memberId");
