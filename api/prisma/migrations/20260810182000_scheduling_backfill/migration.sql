-- Scheduling package B, step 3 (data backfill): legacy bookings become
-- reservations (+ organizer participant + one claim), legacy club-event court
-- blocks become event-kind slot_claims. Legacy times are date + "HH:MM" venue
-- wall clock; they convert to instants through the venue zone (America/
-- New_York, matching the existing club-event default). "24:00" and beyond are
-- handled by minute arithmetic rolling into the next day.

DO $$
DECLARE
  orphans INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphans
  FROM "bookings" b
  WHERE NOT EXISTS (SELECT 1 FROM "resources" r WHERE r."id" = b."facilityId");
  IF orphans > 0 THEN
    RAISE EXCEPTION '% bookings reference facilities with no backfilled resource; repair before migrating', orphans;
  END IF;
END $$;

-- 1. De-conflict: if the historical check-then-insert race ever fired, the
-- table may hold overlapping confirmed rows, which would violate the
-- exclusion constraint. Cancel any confirmed booking overlapping an
-- earlier-created confirmed booking on the same facility and date.
UPDATE "bookings" b
SET "status" = 'cancelled', "updatedAt" = CURRENT_TIMESTAMP
WHERE b."status" = 'confirmed'
  AND EXISTS (
    SELECT 1 FROM "bookings" a
    WHERE a."status" = 'confirmed'
      AND a."facilityType" = b."facilityType"
      AND a."facilityId" = b."facilityId"
      AND a."date" = b."date"
      AND a."id" <> b."id"
      AND (split_part(a."startTime", ':', 1)::int * 60 + split_part(a."startTime", ':', 2)::int)
          < (split_part(b."endTime", ':', 1)::int * 60 + split_part(b."endTime", ':', 2)::int)
      AND (split_part(b."startTime", ':', 1)::int * 60 + split_part(b."startTime", ':', 2)::int)
          < (split_part(a."endTime", ':', 1)::int * 60 + split_part(a."endTime", ':', 2)::int)
      AND (a."createdAt" < b."createdAt" OR (a."createdAt" = b."createdAt" AND a."id" < b."id"))
  );

-- 2. Bookings -> reservations. Ids are preserved; references come from the
-- sequence default; the rate snapshot is the type's current rate (legacy
-- bookings were unpaid, amountPaidCents stays 0, no payment rows).
INSERT INTO "reservations" (
  "id", "resourceTypeId", "resourceId", "organizerId", "startsAt", "endsAt",
  "localDate", "status", "hourlyRateCentsSnapshot", "amountPaidCents",
  "createdAt", "updatedAt"
)
SELECT
  b."id",
  r."typeId",
  b."facilityId",
  b."memberId",
  (b."date"::date::timestamp
     + make_interval(mins => split_part(b."startTime", ':', 1)::int * 60 + split_part(b."startTime", ':', 2)::int))
    AT TIME ZONE 'America/New_York',
  (b."date"::date::timestamp
     + make_interval(mins => split_part(b."endTime", ':', 1)::int * 60 + split_part(b."endTime", ':', 2)::int))
    AT TIME ZONE 'America/New_York',
  to_char(b."date"::date, 'YYYY-MM-DD'),
  CASE b."status" WHEN 'confirmed' THEN 'confirmed' ELSE 'cancelled' END,
  rt."hourlyRateCents",
  0,
  b."createdAt",
  CURRENT_TIMESTAMP
FROM "bookings" b
JOIN "resources" r ON r."id" = b."facilityId"
JOIN "resource_types" rt ON rt."id" = r."typeId";

-- 3. Organizer participant rows (confirmed by definition).
INSERT INTO "reservation_participants" (
  "id", "reservationId", "memberId", "role", "status", "invitedAt"
)
SELECT b."id" || '_org', b."id", b."memberId", 'organizer', 'confirmed', b."createdAt"
FROM "bookings" b;

-- 4. One active claim per confirmed booking.
INSERT INTO "slot_claims" (
  "id", "resourceId", "startsAt", "endsAt", "kind", "reservationId",
  "status", "localDate", "createdAt", "updatedAt"
)
SELECT
  b."id" || '_claim', b."facilityId",
  rv."startsAt", rv."endsAt",
  'reservation', b."id", 'active', rv."localDate",
  b."createdAt", CURRENT_TIMESTAMP
FROM "bookings" b
JOIN "reservations" rv ON rv."id" = b."id"
WHERE b."status" = 'confirmed';

-- 5. Events take precedence over member bookings (the legacy system blocked
-- bookings under active event claims): cancel any migrated reservation whose
-- claim overlaps an active event's court block, then release its claim, so
-- the event claims can be inserted without violating the constraint.
WITH conflicting AS (
  SELECT DISTINCT sc."id" AS claim_id, sc."reservationId" AS reservation_id
  FROM "slot_claims" sc
  JOIN "club_event_courts" cec ON cec."courtId" = sc."resourceId"
  JOIN "club_events" e ON e."id" = cec."eventId" AND e."active" = true
  WHERE sc."kind" = 'reservation'
    AND sc."status" = 'active'
    AND (e."startsAt" AT TIME ZONE 'UTC') < sc."endsAt"
    AND sc."startsAt" < (e."endsAt" AT TIME ZONE 'UTC')
),
released AS (
  UPDATE "slot_claims" SET "status" = 'released', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" IN (SELECT claim_id FROM conflicting)
)
UPDATE "reservations" SET "status" = 'cancelled', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT reservation_id FROM conflicting);

-- 6. ClubEventCourt -> event-kind claims spanning [startsAt, endsAt) per
-- claimed court. Inactive events keep their rows as released (they never
-- blocked availability).
INSERT INTO "slot_claims" (
  "id", "resourceId", "startsAt", "endsAt", "kind", "clubEventId",
  "status", "localDate", "createdAt", "updatedAt"
)
SELECT
  cec."id", cec."courtId",
  e."startsAt" AT TIME ZONE 'UTC',
  e."endsAt" AT TIME ZONE 'UTC',
  'event', e."id",
  CASE WHEN e."active" THEN 'active' ELSE 'released' END,
  to_char((e."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE e."timezone", 'YYYY-MM-DD'),
  cec."createdAt", CURRENT_TIMESTAMP
FROM "club_event_courts" cec
JOIN "club_events" e ON e."id" = cec."eventId";
