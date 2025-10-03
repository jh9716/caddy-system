-- CreateEnum
CREATE TYPE "Status" AS ENUM ('AVAILABLE', 'LEAVE', 'NOTICE', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "Team" AS ENUM ('TEAM_1', 'TEAM_2', 'TEAM_3', 'TEAM_4', 'TEAM_5', 'TEAM_6', 'TEAM_7', 'TEAM_8');

-- CreateTable
CREATE TABLE "Assignment" (
    "id" SERIAL NOT NULL,
    "caddyName" TEXT NOT NULL,
    "team" "Team" NOT NULL,
    "status" "Status" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);
