-- API omit coverage follows shift (existing marshal UI).
-- FULL_DAY is explicit only. Drop silent DB default so it cannot
-- disagree with createPenaltyDuty.
-- Production migrate 실행은 이 PR에서 하지 않는다.

ALTER TABLE "MarshalPenaltyDuty"
  ALTER COLUMN "coverage" DROP DEFAULT;
