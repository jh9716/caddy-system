-- 현장 배치 변경 V1: Reservation / Placement / 당일 비가용 / 변경 이력
-- Production DB에는 이번 PR에서 직접 적용하지 않음 (migrate deploy는 별도 승인).

CREATE TYPE "DailyReservationStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'TEAM_NOSHOW');

CREATE TABLE "DailyReservation" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "course" TEXT NOT NULL,
    "shift" TEXT NOT NULL,
    "teeTime" TEXT NOT NULL,
    "teamName" TEXT,
    "hole" INTEGER,
    "source" TEXT,
    "status" "DailyReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "identityKey" TEXT NOT NULL,
    "rawRowIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyReservation_date_identityKey_key" ON "DailyReservation"("date", "identityKey");
CREATE INDEX "DailyReservation_date_status_idx" ON "DailyReservation"("date", "status");
CREATE INDEX "DailyReservation_date_course_teeTime_idx" ON "DailyReservation"("date", "course", "teeTime");

CREATE TABLE "DailyPlacement" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "sequenceIndex" INTEGER NOT NULL DEFAULT 0,
    "pairId" TEXT,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyPlacement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyPlacement_reservationId_key" ON "DailyPlacement"("reservationId");
CREATE INDEX "DailyPlacement_date_caddyId_idx" ON "DailyPlacement"("date", "caddyId");
CREATE INDEX "DailyPlacement_date_locked_idx" ON "DailyPlacement"("date", "locked");

ALTER TABLE "DailyPlacement" ADD CONSTRAINT "DailyPlacement_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "DailyReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyPlacement" ADD CONSTRAINT "DailyPlacement_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "DailyCaddyUnavailableReason" AS ENUM ('SICK', 'ATTENDANCE_NOSHOW');

CREATE TABLE "DailyCaddyUnavailable" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "reason" "DailyCaddyUnavailableReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyCaddyUnavailable_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyCaddyUnavailable_date_caddyId_key" ON "DailyCaddyUnavailable"("date", "caddyId");
CREATE INDEX "DailyCaddyUnavailable_caddyId_idx" ON "DailyCaddyUnavailable"("caddyId");

ALTER TABLE "DailyCaddyUnavailable" ADD CONSTRAINT "DailyCaddyUnavailable_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "DailyAssignmentChangeType" AS ENUM ('CANCEL_RESERVATION', 'TEAM_NOSHOW', 'CADDY_SICK', 'CADDY_ATTENDANCE_NOSHOW', 'ADD_RESERVATION', 'SWAP_CADDY');

CREATE TABLE "DailyAssignmentChange" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "changeType" "DailyAssignmentChangeType" NOT NULL,
    "cause" TEXT,
    "payload" JSONB,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyAssignmentChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DailyAssignmentChange_date_appliedAt_idx" ON "DailyAssignmentChange"("date", "appliedAt");
