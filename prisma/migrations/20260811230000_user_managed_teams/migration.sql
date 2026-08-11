-- User.managedTeams: 조장 권한 범위 (복수 조 허용, add-only)
-- Production 적용은 별도 승인 후 prisma migrate deploy 로만 수행하세요.
-- OffRequest_caddyId_date_active_key 등 기존 인덱스를 변경·삭제하지 않습니다.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "managedTeams" TEXT[] DEFAULT ARRAY[]::TEXT[];
