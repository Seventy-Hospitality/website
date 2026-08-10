-- Clubs bounded context (Club70 app package D).
-- clubs / club_members / club_invitations / club_invite_links, plus real FKs
-- for the club-linkage columns package B shipped as plain nullable strings
-- (reservations.clubId, reservation_participants.viaClubId): deleting a club
-- unlinks its reservations (SET NULL) instead of stranding dangling ids.
-- Club invitations REQUIRE acceptance (plan OPEN decision 4): membership rows
-- are created only by an accepted invitation or a link join, never directly.
-- Invite-link tokens are stored sha256-hashed at rest like auth_tokens.

-- CreateTable
CREATE TABLE "clubs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "coverImageUrl" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_members" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_invitations" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeMemberId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "club_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_invite_links" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "club_members_clubId_memberId_key" ON "club_members"("clubId", "memberId");

-- CreateIndex
CREATE INDEX "club_members_memberId_idx" ON "club_members"("memberId");

-- CreateIndex
CREATE INDEX "club_invitations_clubId_status_idx" ON "club_invitations"("clubId", "status");

-- CreateIndex
CREATE INDEX "club_invitations_inviteeMemberId_status_idx" ON "club_invitations"("inviteeMemberId", "status");

-- CreateIndex
CREATE INDEX "club_invitations_inviterId_status_idx" ON "club_invitations"("inviterId", "status");

-- At most one ACTIVE (pending) invitation per (club, invitee); historical
-- declined/revoked/accepted rows accumulate freely so a re-invite is a new
-- row. Partial unique indexes cannot be expressed in the Prisma schema; this
-- is the raw-SQL twin of the slot_claims exclusion constraint precedent.
CREATE UNIQUE INDEX "club_invitations_active_invite_key" ON "club_invitations"("clubId", "inviteeMemberId") WHERE "status" = 'pending';

-- CreateIndex
CREATE UNIQUE INDEX "club_invite_links_tokenHash_key" ON "club_invite_links"("tokenHash");

-- CreateIndex
CREATE INDEX "club_invite_links_clubId_revokedAt_idx" ON "club_invite_links"("clubId", "revokedAt");

-- AddForeignKey
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_invitations" ADD CONSTRAINT "club_invitations_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_invitations" ADD CONSTRAINT "club_invitations_inviteeMemberId_fkey" FOREIGN KEY ("inviteeMemberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_invite_links" ADD CONSTRAINT "club_invite_links_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (the club's group-activity feed)
CREATE INDEX "reservations_clubId_startsAt_idx" ON "reservations"("clubId", "startsAt");

-- The club-linkage columns package B left dangling become real FKs. All
-- existing rows hold NULL (the clubIds path answered 422 until now), so no
-- backfill is needed.
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_participants" ADD CONSTRAINT "reservation_participants_viaClubId_fkey" FOREIGN KEY ("viaClubId") REFERENCES "clubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
