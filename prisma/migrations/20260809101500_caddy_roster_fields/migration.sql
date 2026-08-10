-- RECONSTRUCTED from Production schema (DB-only migration was applied 2026-08-09).
-- Original migration.sql was not in git; content restored to match Production end-state.
-- Production _prisma_migrations.checksum (sha256):
--   e189b2ca004bb537cfe0316b3076d8f62159023995c3b4445d6c01ff0cfa6c4f
-- If `prisma migrate deploy` reports a checksum mismatch on Production, sync checksum
-- once (admin-approved UPDATE on _prisma_migrations) BEFORE any new deploy.
-- Do NOT re-run this migration against Production; it is already applied.
-- Safe for fresh/preview DBs that have not yet applied this migration name.

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'LEAVE', 'RETIRED');

-- AlterTable
ALTER TABLE "Caddy" ADD COLUMN     "employeeCode" TEXT,
ADD COLUMN     "employmentStatus" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "missingFromImport" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "teamOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Caddy_employeeCode_key" ON "Caddy"("employeeCode");
