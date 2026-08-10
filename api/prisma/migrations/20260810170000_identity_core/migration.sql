-- Identity core (Club70 app package A, stage 1).
-- users: staffRole replaces the meaningless role default; verification, status
-- and terms columns. New credential/identity/session/token tables. The legacy
-- sessions and magic_link_tokens tables are untouched until cutover.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN "staffRole" TEXT,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN "termsVersion" TEXT;

-- Backfill: admins keep their powers; everyone else has no staff role.
UPDATE "users" SET "staffRole" = 'admin' WHERE "role" = 'admin';

ALTER TABLE "users" DROP COLUMN "role";

-- CreateTable
CREATE TABLE "user_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "isPrivateRelay" BOOLEAN NOT NULL DEFAULT false,
    "refreshTokenEnc" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "previousTokenHash" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "deviceName" TEXT,
    "ip" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "bindingHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_credentials_userId_type_key" ON "user_credentials"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_subject_key" ON "auth_identities"("provider", "subject");

-- CreateIndex
CREATE INDEX "auth_identities_userId_idx" ON "auth_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refreshTokenHash_key" ON "auth_sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_revokedAt_idx" ON "auth_sessions"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_tokens_purpose_identifier_idx" ON "auth_tokens"("purpose", "identifier");

-- AddForeignKey
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
