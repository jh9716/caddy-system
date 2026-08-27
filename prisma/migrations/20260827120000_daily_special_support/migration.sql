-- 날짜·부별 특수지원. DailySpecialDuty / Draft / Published / Schedule 은 변경하지 않는다.
-- Production migrate deploy는 이번 PR에서 실행하지 않는다.
-- CHAGEUN enum/row 는 삭제하지 않는다.

CREATE TABLE "DailySpecialSupport" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "shift" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailySpecialSupport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailySpecialSupport_date_caddyId_shift_key" ON "DailySpecialSupport"("date", "caddyId", "shift");
CREATE INDEX "DailySpecialSupport_date_shift_idx" ON "DailySpecialSupport"("date", "shift");
CREATE INDEX "DailySpecialSupport_caddyId_idx" ON "DailySpecialSupport"("caddyId");

ALTER TABLE "DailySpecialSupport" ADD CONSTRAINT "DailySpecialSupport_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
