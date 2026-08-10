-- RECONSTRUCTED from Production schema (DB-only migration was applied 2026-08-09).
-- Original migration.sql was not in git; content restored to match Production end-state.
-- Production _prisma_migrations.checksum (sha256):
--   fad270d680245d2a099482d2e9af98b0f09b4d6c2faeaf1a8284eb0ea503c7cb
-- If `prisma migrate deploy` reports a checksum mismatch on Production, sync checksum
-- once (admin-approved UPDATE on _prisma_migrations) BEFORE any new deploy.
-- Do NOT re-run this migration against Production; it is already applied.
-- Safe for fresh/preview DBs that have not yet applied this migration name.

-- CreateEnum
CREATE TYPE "CaddyType" AS ENUM ('HOUSE', 'THIRD', 'DRIVING');

-- AlterTable
ALTER TABLE "Caddy" ADD COLUMN     "caddyType" "CaddyType" NOT NULL DEFAULT 'HOUSE';

-- CreateIndex
CREATE INDEX "Caddy_caddyType_idx" ON "Caddy"("caddyType");
