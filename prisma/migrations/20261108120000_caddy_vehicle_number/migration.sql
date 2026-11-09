-- Caddy.vehicleNumber (add-only)
-- - nullable: 기존 캐디 전원 NULL 유지 (backfill 금지)
-- - UNIQUE 없음: 미등록(NULL) 다수 허용, 번호 중복 제약 없음
-- - Caddy/User/OffRequest/Assignment 기존 row update/delete 없음

ALTER TABLE "Caddy" ADD COLUMN IF NOT EXISTS "vehicleNumber" TEXT;
