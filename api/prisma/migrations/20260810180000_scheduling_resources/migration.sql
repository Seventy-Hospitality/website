-- Scheduling package B, step 1 (additive): resource catalog.
-- resource_types carries all facility policy (operating hours as minutes from
-- venue-local midnight, end may exceed 1440); resources are the physical
-- units. Courts and showers are backfilled here; the legacy tables are
-- dropped by a later migration once the code cutover is complete.

-- Membership tiering: PRO gating is data on the plan, not a policy rung.
ALTER TABLE "membership_plans" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'member';

-- CreateTable
CREATE TABLE "resource_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slotDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "opStartMinutes" INTEGER NOT NULL,
    "opEndMinutes" INTEGER NOT NULL,
    "hourlyRateCents" INTEGER NOT NULL,
    "maxAdvanceDays" INTEGER NOT NULL,
    "maxReservationsPerMemberPerDay" INTEGER NOT NULL,
    "cancellationDeadlineMinutes" INTEGER NOT NULL,
    "minTier" TEXT NOT NULL DEFAULT 'member',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "resource_types_code_key" ON "resource_types"("code");

-- CreateIndex
CREATE INDEX "resources_typeId_active_idx" ON "resources"("typeId", "active");

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "resource_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one resource_type per legacy facility class, one resource per
-- legacy row (ids preserved so bookings map by facilityId). Fails loudly if
-- rows of one class carry divergent config: the type is the single policy
-- holder and a silent "pick one" would change behavior for some rows.
-- hourlyRateCents did not exist on the legacy tables; the backfill uses
-- placeholder rates (admin-adjustable data, recorded in
-- docs/decisions-scheduling.md).
DO $$
DECLARE
  court_configs INTEGER;
  shower_configs INTEGER;
BEGIN
  SELECT COUNT(DISTINCT ("slotDurationMinutes", "operatingHoursStart", "operatingHoursEnd",
                        "maxAdvanceDays", "maxBookingsPerMemberPerDay", "cancellationDeadlineMinutes"))
    INTO court_configs FROM "courts";
  IF court_configs > 1 THEN
    RAISE EXCEPTION 'courts have divergent per-row config (% distinct tuples); unify them before migrating', court_configs;
  END IF;

  SELECT COUNT(DISTINCT ("slotDurationMinutes", "operatingHoursStart", "operatingHoursEnd",
                        "maxAdvanceDays", "maxBookingsPerMemberPerDay", "cancellationDeadlineMinutes"))
    INTO shower_configs FROM "showers";
  IF shower_configs > 1 THEN
    RAISE EXCEPTION 'showers have divergent per-row config (% distinct tuples); unify them before migrating', shower_configs;
  END IF;

  IF court_configs = 1 THEN
    INSERT INTO "resource_types" (
      "id", "code", "name", "slotDurationMinutes", "opStartMinutes", "opEndMinutes",
      "hourlyRateCents", "maxAdvanceDays", "maxReservationsPerMemberPerDay",
      "cancellationDeadlineMinutes", "minTier", "active", "displayOrder", "updatedAt"
    )
    SELECT
      'rt_badminton_court', 'badminton_court', 'Badminton Court',
      c."slotDurationMinutes",
      split_part(c."operatingHoursStart", ':', 1)::int * 60 + split_part(c."operatingHoursStart", ':', 2)::int,
      split_part(c."operatingHoursEnd", ':', 1)::int * 60 + split_part(c."operatingHoursEnd", ':', 2)::int,
      2000, c."maxAdvanceDays", c."maxBookingsPerMemberPerDay",
      c."cancellationDeadlineMinutes", 'member', true, 0, CURRENT_TIMESTAMP
    FROM (SELECT DISTINCT "slotDurationMinutes", "operatingHoursStart", "operatingHoursEnd",
                 "maxAdvanceDays", "maxBookingsPerMemberPerDay", "cancellationDeadlineMinutes"
          FROM "courts") c;

    INSERT INTO "resources" ("id", "typeId", "name", "active", "displayOrder", "createdAt", "updatedAt")
    SELECT "id", 'rt_badminton_court', "name", "active",
           row_number() OVER (ORDER BY "name") - 1, "createdAt", CURRENT_TIMESTAMP
    FROM "courts";
  END IF;

  IF shower_configs = 1 THEN
    INSERT INTO "resource_types" (
      "id", "code", "name", "slotDurationMinutes", "opStartMinutes", "opEndMinutes",
      "hourlyRateCents", "maxAdvanceDays", "maxReservationsPerMemberPerDay",
      "cancellationDeadlineMinutes", "minTier", "active", "displayOrder", "updatedAt"
    )
    SELECT
      'rt_shower', 'shower', 'Shower',
      s."slotDurationMinutes",
      split_part(s."operatingHoursStart", ':', 1)::int * 60 + split_part(s."operatingHoursStart", ':', 2)::int,
      split_part(s."operatingHoursEnd", ':', 1)::int * 60 + split_part(s."operatingHoursEnd", ':', 2)::int,
      1000, s."maxAdvanceDays", s."maxBookingsPerMemberPerDay",
      s."cancellationDeadlineMinutes", 'pro', true, 40, CURRENT_TIMESTAMP
    FROM (SELECT DISTINCT "slotDurationMinutes", "operatingHoursStart", "operatingHoursEnd",
                 "maxAdvanceDays", "maxBookingsPerMemberPerDay", "cancellationDeadlineMinutes"
          FROM "showers") s;

    INSERT INTO "resources" ("id", "typeId", "name", "active", "displayOrder", "createdAt", "updatedAt")
    SELECT "id", 'rt_shower', "name", "active",
           row_number() OVER (ORDER BY "name") - 1, "createdAt", CURRENT_TIMESTAMP
    FROM "showers";
  END IF;
END $$;
