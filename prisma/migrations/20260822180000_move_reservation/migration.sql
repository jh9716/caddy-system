-- DailyAssignmentChangeType: 팀 이동(MOVE_RESERVATION) 이력.
-- 이 마이그레이션 파일만 추가한다. production migrate deploy는 이번 PR에서 실행하지 않는다.
ALTER TYPE "DailyAssignmentChangeType" ADD VALUE 'MOVE_RESERVATION';
