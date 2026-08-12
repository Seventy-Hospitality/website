-- Scheduling package B, step 2 (additive, raw SQL): reservation tables and
-- the load-bearing exclusion constraint. slot_claims is the single physical
-- owner of time on a resource; the no-overlap invariant lives ONLY here.

-- The exclusion constraint needs gist support for scalar equality.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Human-facing reservation references: BK-001000, BK-001001, ...
CREATE SEQUENCE "reservation_reference_seq" START WITH 1000;

-- CreateTable
CREATE TABLE "reservation_series" (
    "id" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "resourceTypeId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startTimeLocal" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservation_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL DEFAULT ('BK-' || lpad((nextval('reservation_reference_seq'::regclass))::text, 6, '0')),
    "resourceTypeId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "clubId" TEXT,
    "seriesId" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "localDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "hourlyRateCentsSnapshot" INTEGER NOT NULL,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_participants" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "invitedById" TEXT,
    "viaClubId" TEXT,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "reservation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_payments" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeRefundId" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slot_claims" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "reservationId" TEXT,
    "clubEventId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMPTZ(3),
    "localDate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slot_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservations_reference_key" ON "reservations"("reference");
CREATE INDEX "reservations_organizerId_localDate_idx" ON "reservations"("organizerId", "localDate");
CREATE INDEX "reservations_organizerId_status_startsAt_idx" ON "reservations"("organizerId", "status", "startsAt");
CREATE INDEX "reservations_status_startsAt_idx" ON "reservations"("status", "startsAt");
CREATE INDEX "reservations_localDate_status_idx" ON "reservations"("localDate", "status");
CREATE UNIQUE INDEX "reservation_participants_reservationId_memberId_key" ON "reservation_participants"("reservationId", "memberId");
CREATE INDEX "reservation_participants_memberId_status_idx" ON "reservation_participants"("memberId", "status");
CREATE INDEX "reservation_payments_reservationId_idx" ON "reservation_payments"("reservationId");
CREATE INDEX "slot_claims_resourceId_status_startsAt_idx" ON "slot_claims"("resourceId", "status", "startsAt");
CREATE INDEX "slot_claims_clubEventId_idx" ON "slot_claims"("clubEventId");
CREATE INDEX "slot_claims_status_expiresAt_idx" ON "slot_claims"("status", "expiresAt");
CREATE INDEX "slot_claims_localDate_idx" ON "slot_claims"("localDate");
CREATE INDEX "reservation_series_organizerId_active_idx" ON "reservation_series"("organizerId", "active");

-- AddForeignKey
ALTER TABLE "reservation_series" ADD CONSTRAINT "reservation_series_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservation_series" ADD CONSTRAINT "reservation_series_resourceTypeId_fkey" FOREIGN KEY ("resourceTypeId") REFERENCES "resource_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_resourceTypeId_fkey" FOREIGN KEY ("resourceTypeId") REFERENCES "resource_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "reservation_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reservation_participants" ADD CONSTRAINT "reservation_participants_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservation_participants" ADD CONSTRAINT "reservation_participants_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservation_payments" ADD CONSTRAINT "reservation_payments_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slot_claims" ADD CONSTRAINT "slot_claims_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "slot_claims" ADD CONSTRAINT "slot_claims_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slot_claims" ADD CONSTRAINT "slot_claims_clubEventId_fkey" FOREIGN KEY ("clubEventId") REFERENCES "club_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The single arbiter of no-overlap: two active claims can never overlap on
-- one resource. Prisma cannot express exclusion constraints; the repository
-- maps SQLSTATE 23P01 to SlotUnavailableError. Released rows fall out of the
-- partial predicate, and an UPDATE checks the moved row against other rows
-- only, which gives reschedules self-exclusion for free.
ALTER TABLE "slot_claims" ADD CONSTRAINT "no_overlapping_claims"
  EXCLUDE USING gist ("resourceId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&)
  WHERE ("status" = 'active');

-- One claim per reservation (event claims may span several resources).
CREATE UNIQUE INDEX "slot_claims_reservation_unique" ON "slot_claims"("reservationId")
  WHERE ("kind" = 'reservation');

-- Transactional outbox on the audit log: rows with "dispatchedAt" IS NULL are
-- pending; the dispatcher selects them FOR UPDATE SKIP LOCKED (no seq-cursor
-- checkpoints). Rows recorded before the outbox existed are marked dispatched
-- so the first run does not replay history.
ALTER TABLE "events" ADD COLUMN "dispatchedAt" TIMESTAMP(3);
CREATE INDEX "events_dispatchedAt_idx" ON "events"("dispatchedAt");
UPDATE "events" SET "dispatchedAt" = CURRENT_TIMESTAMP;
