-- 특수근무 2·3부 + 지원근무 V2 컬럼.
-- Production migrate deploy는 이번 PR에서 실행하지 않는다. Preview/local만.

ALTER TYPE "DailySpecialKind" ADD VALUE IF NOT EXISTS 'TWO_THREE';

CREATE TYPE "DailySpecialSupportKind" AS ENUM (
    'CHAGEUN',
    'SPECIAL_SUPPORT',
    'OFF_SUPPORT',
    'MARSHAL_SUPPORT',
    'LEADER_SUPPORT',
    'FIFTY_FOUR_SUPPORT'
);

CREATE TYPE "DailySpecialSupportWorkPattern" AS ENUM (
    'ONE_TWO',
    'SHIFT_1',
    'SHIFT_2',
    'SHIFT_3',
    'FIFTY_FOUR'
);

ALTER TABLE "DailySpecialSupport"
    ADD COLUMN "kind" "DailySpecialSupportKind" NOT NULL DEFAULT 'SPECIAL_SUPPORT',
    ADD COLUMN "workPattern" "DailySpecialSupportWorkPattern" NOT NULL DEFAULT 'SHIFT_1',
    ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

UPDATE "DailySpecialSupport" SET "workPattern" = 'SHIFT_1' WHERE "shift" = '1부';
UPDATE "DailySpecialSupport" SET "workPattern" = 'SHIFT_2' WHERE "shift" = '2부';
UPDATE "DailySpecialSupport" SET "workPattern" = 'SHIFT_3' WHERE "shift" = '3부';

WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY date, shift ORDER BY id) AS rn
    FROM "DailySpecialSupport"
)
UPDATE "DailySpecialSupport" AS s
SET "sortOrder" = numbered.rn
FROM numbered
WHERE s.id = numbered.id;

CREATE INDEX "DailySpecialSupport_date_kind_sortOrder_idx"
    ON "DailySpecialSupport"("date", "kind", "sortOrder");
