-- OffRequest workflow + User.caddyId (add-only)
-- Production 적용은 별도 승인 후 prisma migrate deploy 로만 수행하세요.
-- 이 migration은 기존 Assignment / OFF 데이터를 수정·backfill 하지 않습니다.

-- 1) Enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OffRequestStatus') THEN
    CREATE TYPE "OffRequestStatus" AS ENUM (
      'REQUESTED',
      'APPROVED',
      'REJECTED',
      'CANCELLED'
    );
  END IF;
END $$;

-- 2) User.caddyId (기존 User는 NULL 유지)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "caddyId" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_caddyId_key'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_caddyId_key" UNIQUE ("caddyId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_caddyId_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_caddyId_fkey"
      FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 3) OffRequest table
CREATE TABLE IF NOT EXISTS "OffRequest" (
  "id" SERIAL NOT NULL,
  "caddyId" INTEGER NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "status" "OffRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decidedByUserId" INTEGER,
  "decisionNote" TEXT,
  "assignmentId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OffRequest_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OffRequest_assignmentId_key'
  ) THEN
    ALTER TABLE "OffRequest" ADD CONSTRAINT "OffRequest_assignmentId_key" UNIQUE ("assignmentId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OffRequest_caddyId_fkey'
  ) THEN
    ALTER TABLE "OffRequest"
      ADD CONSTRAINT "OffRequest_caddyId_fkey"
      FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OffRequest_assignmentId_fkey'
  ) THEN
    ALTER TABLE "OffRequest"
      ADD CONSTRAINT "OffRequest_assignmentId_fkey"
      FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "OffRequest_date_status_idx" ON "OffRequest"("date", "status");
CREATE INDEX IF NOT EXISTS "OffRequest_caddyId_date_idx" ON "OffRequest"("caddyId", "date");
CREATE INDEX IF NOT EXISTS "OffRequest_caddyId_status_idx" ON "OffRequest"("caddyId", "status");
CREATE INDEX IF NOT EXISTS "OffRequest_decidedByUserId_idx" ON "OffRequest"("decidedByUserId");

-- 4) Partial unique: 동일 캐디·동일 날짜에 REQUESTED|APPROVED 중복 금지
-- Prisma schema로는 표현 불가 → SQL-only.
-- 주의: 이후 `prisma migrate diff` / db pull 기반 자동 migration이
-- 이 인덱스를 "스키마 밖"으로 보고 DROP을 제안할 수 있음.
-- 인덱스 이름 OffRequest_caddyId_date_active_key 를 절대 제거하지 말 것.
CREATE UNIQUE INDEX IF NOT EXISTS "OffRequest_caddyId_date_active_key"
  ON "OffRequest" ("caddyId", "date")
  WHERE "status" IN ('REQUESTED', 'APPROVED');
