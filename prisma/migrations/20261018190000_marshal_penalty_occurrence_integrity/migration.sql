-- P2 integrity: stale-plan flag, same-day multiple occurrences, idempotency key.
-- Production migrate 실행은 이 PR에서 하지 않는다.

ALTER TABLE "MarshalMonthPlan"
  ADD COLUMN "needsRegeneration" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "MarshalPenaltyOccurrence_caddyId_occurredOn_key";

CREATE INDEX "MarshalPenaltyOccurrence_caddyId_occurredOn_idx"
  ON "MarshalPenaltyOccurrence"("caddyId", "occurredOn");

ALTER TABLE "MarshalPenaltyOccurrence"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "MarshalPenaltyOccurrence_idempotencyKey_key"
  ON "MarshalPenaltyOccurrence"("idempotencyKey");
