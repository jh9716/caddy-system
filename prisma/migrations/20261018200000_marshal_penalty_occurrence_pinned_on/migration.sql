-- P3: admin-pinned duty date on penalty occurrences.
-- Production migrate 실행은 이 PR에서 하지 않는다.

ALTER TABLE "MarshalPenaltyOccurrence"
  ADD COLUMN "pinnedOn" TIMESTAMP(3);
