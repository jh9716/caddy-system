/*
  Warnings:

  - You are about to drop the `Assignment` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "public"."Assignment";

-- DropEnum
DROP TYPE "public"."Status";

-- DropEnum
DROP TYPE "public"."Team";

-- CreateTable
CREATE TABLE "Caddy" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "Caddy_pkey" PRIMARY KEY ("id")
);
