-- 병가 적용 시작 부. null은 기존 종일 제외 의미를 유지한다.
-- Production 데이터 삭제/초기화 없음.

ALTER TABLE "DailyCaddyUnavailable" ADD COLUMN "effectiveFromShift" TEXT;
