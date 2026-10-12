-- Marshal roster P1 (additive). Assignment.MARSHAL / DailyOpsDuty / MARSHAL_SUPPORT 와 분리.
-- Production migrate 실행은 이 PR에서 하지 않는다.

CREATE TYPE "MarshalMonthWindowStatus" AS ENUM ('DRAFT', 'GENERATED', 'REVIEW', 'FINALIZED');
CREATE TYPE "MarshalSlotKind" AS ENUM ('EARLY', 'LATE');
CREATE TYPE "MarshalUnavailKind" AS ENUM ('OFF', 'SICK', 'BLOCKED', 'LEAVE');
CREATE TYPE "MarshalAssignSource" AS ENUM ('ENGINE', 'MANUAL', 'IMPORTED');
CREATE TYPE "MarshalOverrideAction" AS ENUM ('SET', 'CLEAR');

CREATE TABLE "MarshalProfile" (
    "id" SERIAL NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startedOn" TIMESTAMP(3) NOT NULL,
    "seniorCaddyId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarshalProfile_caddyId_key" ON "MarshalProfile"("caddyId");
CREATE INDEX "MarshalProfile_active_idx" ON "MarshalProfile"("active");
CREATE INDEX "MarshalProfile_seniorCaddyId_idx" ON "MarshalProfile"("seniorCaddyId");

ALTER TABLE "MarshalProfile" ADD CONSTRAINT "MarshalProfile_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalProfile" ADD CONSTRAINT "MarshalProfile_seniorCaddyId_fkey" FOREIGN KEY ("seniorCaddyId") REFERENCES "Caddy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MarshalMonthWindow" (
    "id" SERIAL NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "status" "MarshalMonthWindowStatus" NOT NULL DEFAULT 'DRAFT',
    "earlySlotsPerDay" INTEGER NOT NULL DEFAULT 2,
    "lateSlotsPerDay" INTEGER NOT NULL DEFAULT 1,
    "statsSnapshot" JSONB,
    "ruleSnapshot" JSONB,
    "generatedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "finalizedByUserId" INTEGER,
    "engineVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalMonthWindow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarshalMonthWindow_yearMonth_key" ON "MarshalMonthWindow"("yearMonth");
CREATE INDEX "MarshalMonthWindow_status_idx" ON "MarshalMonthWindow"("status");

CREATE TABLE "MarshalMonthAssignment" (
    "id" SERIAL NOT NULL,
    "windowId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "roleKey" TEXT NOT NULL,
    "slotKind" "MarshalSlotKind" NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "teamSnapshot" TEXT NOT NULL,
    "source" "MarshalAssignSource" NOT NULL DEFAULT 'ENGINE',
    "scoreDebug" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalMonthAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarshalMonthAssignment_windowId_date_roleKey_key" ON "MarshalMonthAssignment"("windowId", "date", "roleKey");
CREATE UNIQUE INDEX "MarshalMonthAssignment_windowId_date_caddyId_key" ON "MarshalMonthAssignment"("windowId", "date", "caddyId");
CREATE INDEX "MarshalMonthAssignment_windowId_caddyId_idx" ON "MarshalMonthAssignment"("windowId", "caddyId");

ALTER TABLE "MarshalMonthAssignment" ADD CONSTRAINT "MarshalMonthAssignment_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "MarshalMonthWindow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalMonthAssignment" ADD CONSTRAINT "MarshalMonthAssignment_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MarshalMonthOverride" (
    "id" SERIAL NOT NULL,
    "windowId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "roleKey" TEXT NOT NULL,
    "action" "MarshalOverrideAction" NOT NULL,
    "caddyId" INTEGER,
    "rawName" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalMonthOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarshalMonthOverride_windowId_date_roleKey_key" ON "MarshalMonthOverride"("windowId", "date", "roleKey");
CREATE INDEX "MarshalMonthOverride_windowId_idx" ON "MarshalMonthOverride"("windowId");
CREATE INDEX "MarshalMonthOverride_caddyId_idx" ON "MarshalMonthOverride"("caddyId");

ALTER TABLE "MarshalMonthOverride" ADD CONSTRAINT "MarshalMonthOverride_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "MarshalMonthWindow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalMonthOverride" ADD CONSTRAINT "MarshalMonthOverride_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MarshalMonthUnavail" (
    "id" SERIAL NOT NULL,
    "windowId" INTEGER NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "kind" "MarshalUnavailKind" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalMonthUnavail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarshalMonthUnavail_windowId_caddyId_date_key" ON "MarshalMonthUnavail"("windowId", "caddyId", "date");
CREATE INDEX "MarshalMonthUnavail_windowId_date_idx" ON "MarshalMonthUnavail"("windowId", "date");

ALTER TABLE "MarshalMonthUnavail" ADD CONSTRAINT "MarshalMonthUnavail_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "MarshalMonthWindow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarshalMonthUnavail" ADD CONSTRAINT "MarshalMonthUnavail_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
