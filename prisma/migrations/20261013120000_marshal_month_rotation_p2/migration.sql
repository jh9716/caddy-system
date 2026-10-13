-- Marshal month rotation P2 (additive). DailyOpsDuty / autoAssignEngine / Cart 와 분리.
-- Production migrate 실행은 이 PR에서 하지 않는다.

-- CreateEnum
CREATE TYPE "MarshalMonthPlanStatus" AS ENUM ('DRAFT', 'FINALIZED');

-- CreateEnum
CREATE TYPE "MarshalMonthSlotSource" AS ENUM ('ROTATION', 'MANUAL', 'SUBSTITUTE', 'PENALTY');

-- CreateEnum
CREATE TYPE "MarshalShift" AS ENUM ('AM', 'PM');

-- CreateEnum
CREATE TYPE "MarshalCreditStatus" AS ENUM ('OPEN', 'CONSUMED', 'CANCELLED');

-- AlterTable
ALTER TABLE "MarshalProfile" ADD COLUMN "rotationOrder" INTEGER;

-- CreateIndex
CREATE INDEX "MarshalProfile_rotationOrder_idx" ON "MarshalProfile"("rotationOrder");

-- CreateTable
CREATE TABLE "MarshalMonthPlan" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amSlotsPerDay" INTEGER NOT NULL DEFAULT 2,
    "pmSlotsPerDay" INTEGER NOT NULL DEFAULT 1,
    "status" "MarshalMonthPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "startRotationOrder" INTEGER NOT NULL,
    "nextRotationOrder" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalMonthPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarshalMonthSlot" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "shift" "MarshalShift" NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "marshalProfileId" INTEGER NOT NULL,
    "source" "MarshalMonthSlotSource" NOT NULL,
    "originalCaddyId" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalMonthSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarshalPenaltyDuty" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "shift" "MarshalShift" NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "marshalProfileId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalPenaltyDuty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarshalRotationCredit" (
    "id" SERIAL NOT NULL,
    "marshalProfileId" INTEGER NOT NULL,
    "status" "MarshalCreditStatus" NOT NULL DEFAULT 'OPEN',
    "sourceDate" TIMESTAMP(3),
    "replacedCaddyId" INTEGER,
    "reason" TEXT,
    "note" TEXT,
    "createdByUserId" INTEGER,
    "consumedPlanId" INTEGER,
    "consumedDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalRotationCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarshalMonthPlan_year_month_key" ON "MarshalMonthPlan"("year", "month");
CREATE INDEX "MarshalMonthPlan_status_idx" ON "MarshalMonthPlan"("status");

CREATE UNIQUE INDEX "MarshalMonthSlot_planId_date_shift_slotIndex_key" ON "MarshalMonthSlot"("planId", "date", "shift", "slotIndex");
CREATE UNIQUE INDEX "MarshalMonthSlot_planId_date_caddyId_key" ON "MarshalMonthSlot"("planId", "date", "caddyId");
CREATE INDEX "MarshalMonthSlot_planId_date_idx" ON "MarshalMonthSlot"("planId", "date");
CREATE INDEX "MarshalMonthSlot_caddyId_idx" ON "MarshalMonthSlot"("caddyId");

CREATE UNIQUE INDEX "MarshalPenaltyDuty_planId_date_caddyId_key" ON "MarshalPenaltyDuty"("planId", "date", "caddyId");
CREATE INDEX "MarshalPenaltyDuty_planId_date_idx" ON "MarshalPenaltyDuty"("planId", "date");

CREATE INDEX "MarshalRotationCredit_marshalProfileId_status_idx" ON "MarshalRotationCredit"("marshalProfileId", "status");

-- AddForeignKey
ALTER TABLE "MarshalMonthSlot" ADD CONSTRAINT "MarshalMonthSlot_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MarshalMonthPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalMonthSlot" ADD CONSTRAINT "MarshalMonthSlot_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalMonthSlot" ADD CONSTRAINT "MarshalMonthSlot_marshalProfileId_fkey" FOREIGN KEY ("marshalProfileId") REFERENCES "MarshalProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalMonthSlot" ADD CONSTRAINT "MarshalMonthSlot_originalCaddyId_fkey" FOREIGN KEY ("originalCaddyId") REFERENCES "Caddy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MarshalPenaltyDuty" ADD CONSTRAINT "MarshalPenaltyDuty_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MarshalMonthPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalPenaltyDuty" ADD CONSTRAINT "MarshalPenaltyDuty_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalPenaltyDuty" ADD CONSTRAINT "MarshalPenaltyDuty_marshalProfileId_fkey" FOREIGN KEY ("marshalProfileId") REFERENCES "MarshalProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MarshalRotationCredit" ADD CONSTRAINT "MarshalRotationCredit_marshalProfileId_fkey" FOREIGN KEY ("marshalProfileId") REFERENCES "MarshalProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalRotationCredit" ADD CONSTRAINT "MarshalRotationCredit_replacedCaddyId_fkey" FOREIGN KEY ("replacedCaddyId") REFERENCES "Caddy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
