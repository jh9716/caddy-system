/*
  Warnings:

  - You are about to drop the column `status` on the `Caddy` table. All the data in the column will be lost.
  - You are about to drop the `Schedule` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[name,team]` on the table `Caddy` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "CaddyStatus" AS ENUM ('WORKING', 'OFF', 'SICK', 'LONG_SICK', 'MARSHAL', 'DUTY', 'AM_SHIFT', 'PM_SHIFT', 'H54');

-- DropForeignKey
ALTER TABLE "Schedule" DROP CONSTRAINT "Schedule_caddyId_fkey";

-- AlterTable
ALTER TABLE "Caddy" DROP COLUMN "status",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "memo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "photoUrl" TEXT;

-- DropTable
DROP TABLE "Schedule";

-- CreateTable
CREATE TABLE "CaddyStatusRange" (
    "id" SERIAL NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "type" "CaddyStatus" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "CaddyStatusRange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "details" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Caddy_name_team_key" ON "Caddy"("name", "team");

-- AddForeignKey
ALTER TABLE "CaddyStatusRange" ADD CONSTRAINT "CaddyStatusRange_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
