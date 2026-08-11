-- Account surface (package E), part 2: media generalization + account tables.
--
-- managed_media_assets: publicPath -> storagePath (private assets store a
-- non-URL "private/<dir>/<name>" key, and a column literally named
-- publicPath would eventually be serialized by someone); encryption records
-- the at-rest scheme; purgedAt is the retention proof that the stored
-- object is confirmed gone. Rows discarded under the old order (storage
-- delete happened before the mark) are backfilled as purged.

-- AlterTable
ALTER TABLE "managed_media_assets" RENAME COLUMN "publicPath" TO "storagePath";
ALTER INDEX "managed_media_assets_publicPath_key" RENAME TO "managed_media_assets_storagePath_key";
ALTER TABLE "managed_media_assets" ADD COLUMN "encryption" TEXT,
ADD COLUMN "purgedAt" TIMESTAMP(3);

UPDATE "managed_media_assets" SET "purgedAt" = "discardedAt" WHERE "discardedAt" IS NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "memberId" TEXT NOT NULL,
    "pushNotifications" BOOLEAN NOT NULL DEFAULT true,
    "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
    "bookingReminders" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("memberId")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_verifications" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_submitted',
    "imageAssetRef" TEXT,
    "skippedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByAdminId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "id_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memberId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "steps" JSONB NOT NULL DEFAULT '{}',
    "stepsVersion" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "blockedReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stepUpMethod" TEXT NOT NULL,
    "client" TEXT,
    "ip" TEXT,
    "emailAtRequest" TEXT NOT NULL,
    "memberNumberAtRequest" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_token_key" ON "devices"("token");
CREATE INDEX "devices_memberId_idx" ON "devices"("memberId");
CREATE UNIQUE INDEX "id_verifications_memberId_key" ON "id_verifications"("memberId");
CREATE INDEX "id_verifications_status_submittedAt_idx" ON "id_verifications"("status", "submittedAt");
CREATE UNIQUE INDEX "deletion_requests_userId_key" ON "deletion_requests"("userId");
CREATE INDEX "deletion_requests_status_nextAttemptAt_idx" ON "deletion_requests"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "devices" ADD CONSTRAINT "devices_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_verifications" ADD CONSTRAINT "id_verifications_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
