-- 날짜별 관리자 특수근무 입력 (입력 순서 = 유형 내부 우선순위)
-- Production DB에는 이번 PR에서 직접 적용하지 않음 (migrate deploy는 별도 승인).

CREATE TYPE "DailySpecialKind" AS ENUM ('ONE_MAK', 'ONE_TWO', 'ONE_THREE', 'FIFTY_FOUR', 'CHAGEUN');

CREATE TABLE "DailySpecialDuty" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "kind" "DailySpecialKind" NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailySpecialDuty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailySpecialDuty_date_kind_caddyId_key" ON "DailySpecialDuty"("date", "kind", "caddyId");

CREATE INDEX "DailySpecialDuty_date_kind_sortOrder_idx" ON "DailySpecialDuty"("date", "kind", "sortOrder");

CREATE INDEX "DailySpecialDuty_caddyId_idx" ON "DailySpecialDuty"("caddyId");

ALTER TABLE "DailySpecialDuty" ADD CONSTRAINT "DailySpecialDuty_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
