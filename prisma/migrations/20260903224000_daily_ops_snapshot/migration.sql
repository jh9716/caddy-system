-- 날짜별 관리자 운영현황 snapshot. DailyBoardPublished / DailyBoardDraft / DailyOpsDuty는 변경하지 않는다.
-- additive only. Production migrate deploy는 이번 PR에서 실행하지 않는다.

CREATE TABLE "DailyOpsSnapshot" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyOpsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyOpsSnapshot_date_key" ON "DailyOpsSnapshot"("date");
CREATE INDEX "DailyOpsSnapshot_capturedAt_idx" ON "DailyOpsSnapshot"("capturedAt");
