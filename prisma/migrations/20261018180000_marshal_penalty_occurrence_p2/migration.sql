-- Marshal penalty occurrence P2.
-- Independent of month plan. occurredOn vs scheduledOn.
-- Production migrate 실행은 이 PR에서 하지 않는다.

CREATE TYPE "MarshalPenaltyOccurrenceStatus" AS ENUM ('OPEN', 'SCHEDULED', 'CANCELLED');

CREATE TABLE "MarshalPenaltyOccurrence" (
    "id" SERIAL NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "marshalProfileId" INTEGER NOT NULL,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "targetYear" INTEGER NOT NULL,
    "targetMonth" INTEGER NOT NULL,
    "scheduledOn" TIMESTAMP(3),
    "scheduledPlanId" INTEGER,
    "status" "MarshalPenaltyOccurrenceStatus" NOT NULL DEFAULT 'OPEN',
    "deferReason" TEXT,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalPenaltyOccurrence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarshalPenaltyOccurrence_caddyId_occurredOn_key"
  ON "MarshalPenaltyOccurrence"("caddyId", "occurredOn");
CREATE INDEX "MarshalPenaltyOccurrence_targetYear_targetMonth_status_idx"
  ON "MarshalPenaltyOccurrence"("targetYear", "targetMonth", "status");
CREATE INDEX "MarshalPenaltyOccurrence_scheduledPlanId_idx"
  ON "MarshalPenaltyOccurrence"("scheduledPlanId");
CREATE INDEX "MarshalPenaltyOccurrence_caddyId_idx"
  ON "MarshalPenaltyOccurrence"("caddyId");

ALTER TABLE "MarshalPenaltyOccurrence"
  ADD CONSTRAINT "MarshalPenaltyOccurrence_caddyId_fkey"
  FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalPenaltyOccurrence"
  ADD CONSTRAINT "MarshalPenaltyOccurrence_marshalProfileId_fkey"
  FOREIGN KEY ("marshalProfileId") REFERENCES "MarshalProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalPenaltyOccurrence"
  ADD CONSTRAINT "MarshalPenaltyOccurrence_scheduledPlanId_fkey"
  FOREIGN KEY ("scheduledPlanId") REFERENCES "MarshalMonthPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
