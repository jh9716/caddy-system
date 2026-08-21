-- 당일 당번·마샬·조장 운영 일정 (파싱된 date+caddyId+role)
-- ShiftDuty / DailySpecialDuty / Assignment 와 분리.
-- 자동배치·라이브 reflow가 브라우저 업로드 세션이 아니라 이 테이블을 읽는다.

CREATE TYPE "DailyOpsDutyRole" AS ENUM ('DUTY_AM', 'DUTY_PM', 'MARSHAL_AM', 'MARSHAL_PM', 'LEADER');

CREATE TABLE "DailyOpsDuty" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "role" "DailyOpsDutyRole" NOT NULL,
    "roleKey" TEXT NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "rawName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyOpsDuty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyOpsDuty_date_roleKey_key" ON "DailyOpsDuty"("date", "roleKey");

CREATE UNIQUE INDEX "DailyOpsDuty_date_role_caddyId_key" ON "DailyOpsDuty"("date", "role", "caddyId");

CREATE INDEX "DailyOpsDuty_date_caddyId_idx" ON "DailyOpsDuty"("date", "caddyId");

CREATE INDEX "DailyOpsDuty_caddyId_idx" ON "DailyOpsDuty"("caddyId");

ALTER TABLE "DailyOpsDuty" ADD CONSTRAINT "DailyOpsDuty_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
