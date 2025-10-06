-- =========================================
-- Safe rework of previous migration
-- =========================================

BEGIN;

-- 1) 새 ENUM (배정/특이사항 타입)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssignmentType') THEN
        CREATE TYPE "AssignmentType" AS ENUM ('OFF', 'SICK', 'LONG_SICK', 'DUTY', 'MARSHAL');
    END IF;
END $$;

-- 2) 기존 FK/인덱스 정리(있을 때만)
ALTER TABLE "CaddyStatusRange" DROP CONSTRAINT IF EXISTS "CaddyStatusRange_caddyId_fkey";
DROP INDEX IF EXISTS "Caddy_name_team_key";

-- 3) Caddy 테이블 스키마 변경
--  - photoUrl 제거
--  - status 텍스트 컬럼(기본값 '근무중')
--  - updatedAt 안전 추가(기본값으로 백필) → 이후 기본값 제거 옵션
--  - memo는 NULL 허용 및 기본값 제거
ALTER TABLE "Caddy"
    DROP COLUMN IF EXISTS "photoUrl",
    ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT '근무중',
    ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "memo" DROP NOT NULL,
    ALTER COLUMN "memo" DROP DEFAULT;

-- 필요하면 기본값은 이후에 제거(선택)
ALTER TABLE "Caddy"
    ALTER COLUMN "updatedAt" DROP DEFAULT;

-- 4) 불필요한 테이블 제거(있을 때만)
DROP TABLE IF EXISTS "AuditLog";
DROP TABLE IF EXISTS "CaddyStatusRange";

-- 5) 더 이상 쓰지 않는 ENUM 제거(있을 때만)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CaddyStatus') THEN
        DROP TYPE "CaddyStatus";
    END IF;
END $$;

-- 6) Assignment 테이블 생성(있지 않을 때만)
CREATE TABLE IF NOT EXISTS "Assignment" (
    "id" SERIAL PRIMARY KEY,
    "caddyId" INTEGER NOT NULL,
    "type" "AssignmentType" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate"   TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7) FK 부여(중복 방지)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'Assignment_caddyId_fkey'
    ) THEN
        ALTER TABLE "Assignment"
            ADD CONSTRAINT "Assignment_caddyId_fkey"
            FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

COMMIT;
