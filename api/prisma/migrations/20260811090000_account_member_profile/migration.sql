-- Account surface (package E), part 1: member profile fields.
-- memberNumber is the stable human-facing member id ("#A12345"): one
-- uppercase letter (I and O excluded to avoid 1/0 confusion) + five digits.
-- Generated at member creation by the app; existing rows are backfilled here
-- with the same alphabet. Unique forever: deletion anonymizes the row but
-- keeps its memberNumber, so a number can never be reassigned.

-- AlterTable
ALTER TABLE "members" ADD COLUMN "memberNumber" TEXT,
ADD COLUMN "displayName" TEXT,
ADD COLUMN "avatarUrl" TEXT,
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Backfill: random candidate per row, retrying on the (unlikely) collision.
DO $$
DECLARE
  row_id TEXT;
  candidate TEXT;
  letters CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
BEGIN
  FOR row_id IN SELECT "id" FROM "members" WHERE "memberNumber" IS NULL ORDER BY "createdAt", "id" LOOP
    LOOP
      candidate := substr(letters, 1 + floor(random() * 24)::int, 1)
        || lpad(floor(random() * 100000)::int::text, 5, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "members" WHERE "memberNumber" = candidate);
    END LOOP;
    UPDATE "members" SET "memberNumber" = candidate WHERE "id" = row_id;
  END LOOP;
END $$;

ALTER TABLE "members" ALTER COLUMN "memberNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "members_memberNumber_key" ON "members"("memberNumber");
