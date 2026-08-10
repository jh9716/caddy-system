-- Caddy 운영 관리 필드 추가 (ID/관계 보존, 물리 삭제 없음)
-- Production 적용은 별도 승인 후 migrate deploy 로만 수행하세요.

-- 일부 환경에 status 컬럼이 없을 수 있어 안전하게 보정
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Caddy' AND column_name = 'status'
  ) THEN
    ALTER TABLE "Caddy" ADD COLUMN "status" TEXT DEFAULT '근무중';
  END IF;
END $$;

ALTER TABLE "Caddy" ADD COLUMN IF NOT EXISTS "teamOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Caddy" ADD COLUMN IF NOT EXISTS "employmentStatus" TEXT NOT NULL DEFAULT '재직';
ALTER TABLE "Caddy" ADD COLUMN IF NOT EXISTS "extraFlags" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS "Caddy_team_teamOrder_idx" ON "Caddy"("team", "teamOrder");
CREATE INDEX IF NOT EXISTS "Caddy_employmentStatus_idx" ON "Caddy"("employmentStatus");
