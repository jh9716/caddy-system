-- 날짜별 배치 작업본(Draft). DailyReservation / DailyPlacement / Schedule / ShiftDuty는 변경하지 않는다.
-- Production migrate deploy는 이번 PR에서 실행하지 않는다.

CREATE TABLE "DailyBoardDraft" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyBoardDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyBoardDraft_date_key" ON "DailyBoardDraft"("date");
CREATE INDEX "DailyBoardDraft_updatedAt_idx" ON "DailyBoardDraft"("updatedAt");
