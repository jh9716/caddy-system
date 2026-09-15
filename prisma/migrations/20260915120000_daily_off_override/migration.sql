-- 현장 휴무 수동 overlay (additive).
-- OFF Spreadsheet / offSnapshot / DailyCaddyUnavailable / DailyOpsDuty 는 변경하지 않는다.
-- Production migrate deploy는 이번 PR에서 실행하지 않는다.

CREATE TYPE "DailyOffOverrideAction" AS ENUM ('FORCE_OFF', 'FORCE_AVAILABLE');

CREATE TABLE "DailyOffOverride" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "action" "DailyOffOverrideAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyOffOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyOffOverride_date_caddyId_key"
    ON "DailyOffOverride"("date", "caddyId");

CREATE INDEX "DailyOffOverride_date_idx" ON "DailyOffOverride"("date");

CREATE INDEX "DailyOffOverride_caddyId_idx" ON "DailyOffOverride"("caddyId");

ALTER TABLE "DailyOffOverride"
    ADD CONSTRAINT "DailyOffOverride_caddyId_fkey"
    FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
