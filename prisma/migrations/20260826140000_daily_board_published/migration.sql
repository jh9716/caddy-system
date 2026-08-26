-- 날짜별 최종 확정 배치표. Draft / DailyReservation / DailyPlacement / Schedule / ShiftDuty는 변경하지 않는다.
-- Production migrate deploy는 이번 PR에서 실행하지 않는다.

CREATE TABLE "DailyBoardPublished" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "sourceDraftVersion" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "publishedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyBoardPublished_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyBoardPublished_date_key" ON "DailyBoardPublished"("date");
CREATE INDEX "DailyBoardPublished_publishedAt_idx" ON "DailyBoardPublished"("publishedAt");
