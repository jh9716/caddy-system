-- Caddy.phoneNormalized (add-only)
-- - nullable: 기존 183~184명 전원 NULL 유지 (backfill 금지)
-- - UNIQUE: non-null 값만 중복 금지 (PostgreSQL UNIQUE는 NULL 다수 허용)
-- - Caddy/User/OffRequest/Assignment 기존 row update/delete 없음

ALTER TABLE "Caddy" ADD COLUMN IF NOT EXISTS "phoneNormalized" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Caddy_phoneNormalized_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Caddy_phoneNormalized_key'
  ) THEN
    ALTER TABLE "Caddy" ADD CONSTRAINT "Caddy_phoneNormalized_key" UNIQUE ("phoneNormalized");
  END IF;
END $$;
