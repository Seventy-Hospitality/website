-- CreateTable
CREATE TABLE "courts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slotDurationMinutes" INTEGER NOT NULL DEFAULT 60,
    "operatingHoursStart" TEXT NOT NULL DEFAULT '07:00',
    "operatingHoursEnd" TEXT NOT NULL DEFAULT '22:00',
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 7,
    "maxBookingsPerMemberPerDay" INTEGER NOT NULL DEFAULT 2,
    "cancellationDeadlineMinutes" INTEGER NOT NULL DEFAULT 60,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "showers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slotDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "operatingHoursStart" TEXT NOT NULL DEFAULT '07:00',
    "operatingHoursEnd" TEXT NOT NULL DEFAULT '22:00',
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 3,
    "maxBookingsPerMemberPerDay" INTEGER NOT NULL DEFAULT 1,
    "cancellationDeadlineMinutes" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "showers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "facilityType" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bookings_facilityType_facilityId_date_status_idx" ON "bookings"("facilityType", "facilityId", "date", "status");

-- CreateIndex
CREATE INDEX "bookings_memberId_date_idx" ON "bookings"("memberId", "date");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
