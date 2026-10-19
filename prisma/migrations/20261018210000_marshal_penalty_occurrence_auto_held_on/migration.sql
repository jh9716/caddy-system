-- P3: persist the first AUTO duty date so regenerate cannot forget leftover dates.
-- Production migrate 실행은 이 PR에서 하지 않는다.

ALTER TABLE "MarshalPenaltyOccurrence"
  ADD COLUMN "autoHeldOn" TIMESTAMP(3);

UPDATE "MarshalPenaltyOccurrence"
SET "autoHeldOn" = "scheduledOn"
WHERE "autoHeldOn" IS NULL
  AND "pinnedOn" IS NULL
  AND "status" = 'SCHEDULED'
  AND "scheduledOn" IS NOT NULL;
