-- OffRequest monthly window (additive only)
-- Does not modify Assignment / DailyBoard / auto-assign tables or data.
-- Does not DROP or alter OffRequest_caddyId_date_active_key.

-- 1) Additive enum value. Partial unique stays REQUESTED|APPROVED only.
ALTER TYPE "OffRequestStatus" ADD VALUE IF NOT EXISTS 'UNSELECTED';

-- 2) Window status enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OffRequestWindowStatus') THEN
    CREATE TYPE "OffRequestWindowStatus" AS ENUM (
      'DRAFT',
      'OPEN',
      'ADJUSTING',
      'FINALIZED'
    );
  END IF;
END $$;

-- 3) OffRequestWindow
CREATE TABLE IF NOT EXISTS "OffRequestWindow" (
  "id" SERIAL NOT NULL,
  "yearMonth" TEXT NOT NULL,
  "status" "OffRequestWindowStatus" NOT NULL DEFAULT 'DRAFT',
  "openAt" TIMESTAMP(3) NOT NULL,
  "closeAt" TIMESTAMP(3) NOT NULL,
  "adjustingAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "finalizedByUserId" INTEGER,
  "defaultQuota" INTEGER NOT NULL DEFAULT 5,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OffRequestWindow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OffRequestWindow_yearMonth_key"
  ON "OffRequestWindow"("yearMonth");
CREATE INDEX IF NOT EXISTS "OffRequestWindow_status_idx"
  ON "OffRequestWindow"("status");

-- 4) OffRequestQuota
CREATE TABLE IF NOT EXISTS "OffRequestQuota" (
  "id" SERIAL NOT NULL,
  "windowId" INTEGER NOT NULL,
  "team" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "limit" INTEGER NOT NULL,
  CONSTRAINT "OffRequestQuota_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OffRequestQuota_windowId_team_date_key"
  ON "OffRequestQuota"("windowId", "team", "date");
CREATE INDEX IF NOT EXISTS "OffRequestQuota_windowId_team_idx"
  ON "OffRequestQuota"("windowId", "team");
CREATE INDEX IF NOT EXISTS "OffRequestQuota_date_idx"
  ON "OffRequestQuota"("date");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OffRequestQuota_windowId_fkey'
  ) THEN
    ALTER TABLE "OffRequestQuota"
      ADD CONSTRAINT "OffRequestQuota_windowId_fkey"
      FOREIGN KEY ("windowId") REFERENCES "OffRequestWindow"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 5) OffRequestAdjustment
CREATE TABLE IF NOT EXISTS "OffRequestAdjustment" (
  "id" SERIAL NOT NULL,
  "offRequestId" INTEGER NOT NULL,
  "fromDate" TIMESTAMP(3) NOT NULL,
  "toDate" TIMESTAMP(3) NOT NULL,
  "adjustedByUserId" INTEGER NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OffRequestAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OffRequestAdjustment_offRequestId_idx"
  ON "OffRequestAdjustment"("offRequestId");
CREATE INDEX IF NOT EXISTS "OffRequestAdjustment_adjustedByUserId_idx"
  ON "OffRequestAdjustment"("adjustedByUserId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OffRequestAdjustment_offRequestId_fkey'
  ) THEN
    ALTER TABLE "OffRequestAdjustment"
      ADD CONSTRAINT "OffRequestAdjustment_offRequestId_fkey"
      FOREIGN KEY ("offRequestId") REFERENCES "OffRequest"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 6) OffRequestTeamFinalization (schema only in Phase 1)
CREATE TABLE IF NOT EXISTS "OffRequestTeamFinalization" (
  "id" SERIAL NOT NULL,
  "windowId" INTEGER NOT NULL,
  "team" TEXT NOT NULL,
  "finalizedAt" TIMESTAMP(3) NOT NULL,
  "finalizedByUserId" INTEGER,
  CONSTRAINT "OffRequestTeamFinalization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OffRequestTeamFinalization_windowId_team_key"
  ON "OffRequestTeamFinalization"("windowId", "team");
CREATE INDEX IF NOT EXISTS "OffRequestTeamFinalization_windowId_idx"
  ON "OffRequestTeamFinalization"("windowId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OffRequestTeamFinalization_windowId_fkey'
  ) THEN
    ALTER TABLE "OffRequestTeamFinalization"
      ADD CONSTRAINT "OffRequestTeamFinalization_windowId_fkey"
      FOREIGN KEY ("windowId") REFERENCES "OffRequestWindow"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
