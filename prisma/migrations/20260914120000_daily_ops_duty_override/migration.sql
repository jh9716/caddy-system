-- 당번·마샬·조장 날짜별 현장 수동 override (additive).
-- DailyOpsDuty 컬럼/row는 변경하지 않는다. SET/CLEAR는 이 테이블만.
-- Production migrate deploy는 이번 PR에서 실행하지 않는다.

CREATE TYPE "DailyOpsDutyOverrideAction" AS ENUM ('SET', 'CLEAR');

CREATE TABLE "DailyOpsDutyOverride" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "role" "DailyOpsDutyRole" NOT NULL,
    "roleKey" TEXT NOT NULL,
    "action" "DailyOpsDutyOverrideAction" NOT NULL,
    "caddyId" INTEGER,
    "rawName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyOpsDutyOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyOpsDutyOverride_date_roleKey_key"
    ON "DailyOpsDutyOverride"("date", "roleKey");

CREATE INDEX "DailyOpsDutyOverride_date_idx" ON "DailyOpsDutyOverride"("date");

CREATE INDEX "DailyOpsDutyOverride_caddyId_idx" ON "DailyOpsDutyOverride"("caddyId");

ALTER TABLE "DailyOpsDutyOverride"
    ADD CONSTRAINT "DailyOpsDutyOverride_caddyId_fkey"
    FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DailyOpsDutyOverride"
    ADD CONSTRAINT "DailyOpsDutyOverride_action_caddy_chk"
    CHECK (
        ("action" = 'SET' AND "caddyId" IS NOT NULL) OR
        ("action" = 'CLEAR' AND "caddyId" IS NULL)
    );
