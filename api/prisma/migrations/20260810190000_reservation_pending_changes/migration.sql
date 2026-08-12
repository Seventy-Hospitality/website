-- Scheduling review fix: a reschedule that GROWS the reservation must not
-- commit the claim move before the delta charge is captured (an on-session
-- PaymentIntent cannot be captured synchronously). The requested change is
-- parked here and applied by confirm() once the delta PaymentIntent
-- succeeds; the sweeper applies paid changes and drops unpaid ones at
-- expiry. Shrink/equal reschedules still apply immediately.

-- CreateTable
CREATE TABLE "reservation_pending_changes" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "localDate" TEXT NOT NULL,
    "deltaCents" INTEGER NOT NULL,
    "chargePaymentId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_pending_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_pending_changes_reservationId_key" ON "reservation_pending_changes"("reservationId");
CREATE UNIQUE INDEX "reservation_pending_changes_chargePaymentId_key" ON "reservation_pending_changes"("chargePaymentId");
CREATE INDEX "reservation_pending_changes_expiresAt_idx" ON "reservation_pending_changes"("expiresAt");

-- AddForeignKey
ALTER TABLE "reservation_pending_changes" ADD CONSTRAINT "reservation_pending_changes_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservation_pending_changes" ADD CONSTRAINT "reservation_pending_changes_chargePaymentId_fkey" FOREIGN KEY ("chargePaymentId") REFERENCES "reservation_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservation_pending_changes" ADD CONSTRAINT "reservation_pending_changes_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
