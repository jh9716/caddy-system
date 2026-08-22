-- 날짜별 1·3부/1막 1부 위치 정책 (AUTO 순번 창 / MANUAL 기존 anchor).
-- DailySpecialDutyAnchor는 삭제·변경하지 않는다. MANUAL 전용으로 유지.
-- production migrate deploy는 이번 PR에서 실행하지 않는다.

CREATE TYPE "DailySpecialPlacementMode" AS ENUM ('AUTO', 'MANUAL');

CREATE TABLE "DailySpecialPlacementSetting" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "mode" "DailySpecialPlacementMode" NOT NULL DEFAULT 'AUTO',
    "protectedTailCount" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySpecialPlacementSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailySpecialPlacementSetting_date_key" ON "DailySpecialPlacementSetting"("date");

CREATE INDEX "DailySpecialPlacementSetting_date_idx" ON "DailySpecialPlacementSetting"("date");

-- 기존 anchor가 있는 날짜만 MANUAL로 backfill. anchor 없는 날짜는 row를 만들지 않는다.
INSERT INTO "DailySpecialPlacementSetting" ("date", "mode", "protectedTailCount", "createdAt", "updatedAt")
SELECT DISTINCT "date", 'MANUAL'::"DailySpecialPlacementMode", 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "DailySpecialDutyAnchor"
ON CONFLICT ("date") DO NOTHING;
