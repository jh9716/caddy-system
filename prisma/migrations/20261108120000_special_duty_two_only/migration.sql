-- 특수근무 2부 단독(TWO) + 지정 코스/티타임.
-- Production/Preview migrate deploy는 이번 PR에서 실행하지 않는다.

ALTER TYPE "DailySpecialKind" ADD VALUE IF NOT EXISTS 'TWO';

ALTER TABLE "DailySpecialDuty"
    ADD COLUMN IF NOT EXISTS "course" TEXT,
    ADD COLUMN IF NOT EXISTS "teeTime" TEXT;
