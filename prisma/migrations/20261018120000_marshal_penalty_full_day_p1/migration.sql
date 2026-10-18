-- Marshal penalty FULL_DAY P1.
-- Same caddy may occupy AM + PM only as a pair of distinct shifts.
-- Existing penalty rows keep single-shift meaning via coverage = shift.
-- Production migrate 실행은 이 PR에서 하지 않는다.

-- CreateEnum
CREATE TYPE "MarshalPenaltyCoverage" AS ENUM ('FULL_DAY', 'AM', 'PM');

-- Drop the unique that blocked AM+PM same caddy on one day.
DROP INDEX "MarshalMonthSlot_planId_date_caddyId_key";

-- Same caddy + same shift remains forbidden; AM+PM is allowed.
CREATE UNIQUE INDEX "MarshalMonthSlot_planId_date_shift_caddyId_key"
  ON "MarshalMonthSlot"("planId", "date", "shift", "caddyId");

-- coverage: backfill existing rows from shift so stored meaning does not change.
ALTER TABLE "MarshalPenaltyDuty"
  ADD COLUMN "coverage" "MarshalPenaltyCoverage";

UPDATE "MarshalPenaltyDuty"
SET "coverage" = CASE
  WHEN "shift"::text = 'AM' THEN 'AM'::"MarshalPenaltyCoverage"
  ELSE 'PM'::"MarshalPenaltyCoverage"
END
WHERE "coverage" IS NULL;

ALTER TABLE "MarshalPenaltyDuty"
  ALTER COLUMN "coverage" SET NOT NULL,
  ALTER COLUMN "coverage" SET DEFAULT 'FULL_DAY'::"MarshalPenaltyCoverage";
