-- Notifications + weekly-series wiring (package F).
--
-- delivered_notifications: idempotency ledger for the outbox consumer, one
-- row per (event seq, recipient, channel); claimed before sending so
-- redelivery or concurrent dispatchers never double-send, while a claim
-- that never reached "sent" retries instead of dropping.
-- booking_reminders: at most one reminder per (reservation, member).
-- reservation_series: creation is admin-only (OPEN decision 8), so the
-- creating admin is recorded; reservation_series_skips records occurrences
-- the materializer could not create (notify once, never silently shift).
-- The table has no creation surface before this package, so it is empty and
-- the NOT NULL column needs no backfill.

-- CreateTable
CREATE TABLE "delivered_notifications" (
    "id" TEXT NOT NULL,
    "eventSeq" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "delivered_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivered_notifications_eventSeq_recipient_channel_key"
    ON "delivered_notifications"("eventSeq", "recipient", "channel");

-- CreateTable
CREATE TABLE "booking_reminders" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "booking_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_reminders_reservationId_memberId_key"
    ON "booking_reminders"("reservationId", "memberId");

-- AlterTable
ALTER TABLE "reservation_series" ADD COLUMN "createdByAdminId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "reservation_series_skips" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_series_skips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_series_skips_seriesId_localDate_key"
    ON "reservation_series_skips"("seriesId", "localDate");

-- AddForeignKey
ALTER TABLE "reservation_series_skips" ADD CONSTRAINT "reservation_series_skips_seriesId_fkey"
    FOREIGN KEY ("seriesId") REFERENCES "reservation_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One materialized reservation per series occurrence, whatever its status:
-- a cancelled occurrence stays cancelled (never re-materialized) and two
-- concurrent materializer passes cannot double-book a week. Partial unique
-- because Prisma cannot express it.
CREATE UNIQUE INDEX "reservations_series_occurrence_key"
    ON "reservations"("seriesId", "localDate")
    WHERE "seriesId" IS NOT NULL;
