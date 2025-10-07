-- CreateEnum
CREATE TYPE "ShiftPart" AS ENUM ('ONE', 'TWO', 'THREE');

-- CreateEnum
CREATE TYPE "ShiftVariant" AS ENUM ('NORMAL', 'ONE_THREE', 'ONE_TWO', 'FIFTY_FOUR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AssignmentType" ADD VALUE 'ACCIDENT';
ALTER TYPE "AssignmentType" ADD VALUE 'FAMILY_EVENT';

-- CreateTable
CREATE TABLE "ShiftDuty" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "part" "ShiftPart" NOT NULL,
    "variant" "ShiftVariant" NOT NULL DEFAULT 'NORMAL',
    "orderNo" INTEGER NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "team" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftDuty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftDuty_date_part_idx" ON "ShiftDuty"("date", "part");

-- AddForeignKey
ALTER TABLE "ShiftDuty" ADD CONSTRAINT "ShiftDuty_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
