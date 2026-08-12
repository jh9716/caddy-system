-- CaddyLinkRequest (add-only)
-- - enum + table + FK/index only
-- - User / Caddy / OffRequest / Assignment 기존 row UPDATE/DELETE/backfill 없음
-- - 기존 컬럼 ALTER 없음
--
-- Partial unique (Prisma schema 표현 불가 → SQL-only):
--   CaddyLinkRequest_userId_pending_key
-- 주의: 이후 `prisma migrate diff` / db pull 기반 자동 migration이
-- 이 인덱스를 "스키마 밖"으로 보고 DROP을 제안할 수 있음.
-- 인덱스 이름 CaddyLinkRequest_userId_pending_key 를 절대 제거하지 말 것.
-- (동일 정책: OffRequest_caddyId_date_active_key)

-- 1) enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'CaddyLinkRequestStatus'
  ) THEN
    CREATE TYPE "CaddyLinkRequestStatus" AS ENUM (
      'PENDING',
      'APPROVED',
      'REJECTED',
      'CANCELLED'
    );
  END IF;
END $$;

-- 2) table
CREATE TABLE IF NOT EXISTS "CaddyLinkRequest" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "submittedName" TEXT NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "candidateCaddyIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "selectedCaddyId" INTEGER,
    "status" "CaddyLinkRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" INTEGER,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaddyLinkRequest_pkey" PRIMARY KEY ("id")
);

-- 3) FK
-- userId: Restrict — User 물리 삭제 시 요청 이력이 있으면어지지 않도록 차단
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CaddyLinkRequest_userId_fkey'
  ) THEN
    ALTER TABLE "CaddyLinkRequest"
      ADD CONSTRAINT "CaddyLinkRequest_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- selectedCaddyId: SetNull — Caddy 물리 삭제 시 요청 row 유지(이력), 선택 id만 null
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CaddyLinkRequest_selectedCaddyId_fkey'
  ) THEN
    ALTER TABLE "CaddyLinkRequest"
      ADD CONSTRAINT "CaddyLinkRequest_selectedCaddyId_fkey"
      FOREIGN KEY ("selectedCaddyId") REFERENCES "Caddy"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- decidedByUserId: FK 없음 (OffRequest.decidedByUserId 와 동일 — admin User 삭제와 감사 이력 분리)

-- 4) indexes
CREATE INDEX IF NOT EXISTS "CaddyLinkRequest_status_requestedAt_idx"
  ON "CaddyLinkRequest"("status", "requestedAt");

CREATE INDEX IF NOT EXISTS "CaddyLinkRequest_userId_status_idx"
  ON "CaddyLinkRequest"("userId", "status");

CREATE INDEX IF NOT EXISTS "CaddyLinkRequest_phoneNormalized_idx"
  ON "CaddyLinkRequest"("phoneNormalized");

CREATE INDEX IF NOT EXISTS "CaddyLinkRequest_decidedByUserId_idx"
  ON "CaddyLinkRequest"("decidedByUserId");

-- 5) Partial unique: 사용자당 PENDING 1건
CREATE UNIQUE INDEX IF NOT EXISTS "CaddyLinkRequest_userId_pending_key"
  ON "CaddyLinkRequest" ("userId")
  WHERE "status" = 'PENDING';
