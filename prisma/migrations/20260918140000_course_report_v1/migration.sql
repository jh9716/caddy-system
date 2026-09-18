-- CourseReport text-only V1. Additive only.
-- No DROP, no destructive ALTER on existing tables, no data rewrite, no seed.
-- Production migrate deploy is NOT run in this PR.

CREATE TYPE "CourseReportCategory" AS ENUM (
  'COURSE_CONDITION',
  'CART_PATH',
  'FACILITY',
  'SAFETY',
  'LOST_FOUND',
  'OTHER'
);

CREATE TYPE "CourseReportStatus" AS ENUM (
  'RECEIVED',
  'CHECKING',
  'RESOLVED'
);

CREATE TABLE "CourseReport" (
  "id" SERIAL NOT NULL,
  "authorUserId" INTEGER NOT NULL,
  "authorCaddyId" INTEGER,
  "authorDisplayName" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "course" TEXT NOT NULL,
  "hole" INTEGER,
  "category" "CourseReportCategory" NOT NULL,
  "status" "CourseReportStatus" NOT NULL DEFAULT 'RECEIVED',
  "handlerUserId" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CourseReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourseReport_deletedAt_status_createdAt_idx"
  ON "CourseReport"("deletedAt", "status", "createdAt");

CREATE INDEX "CourseReport_authorUserId_idx"
  ON "CourseReport"("authorUserId");

CREATE INDEX "CourseReport_course_hole_idx"
  ON "CourseReport"("course", "hole");

CREATE INDEX "CourseReport_category_idx"
  ON "CourseReport"("category");

ALTER TABLE "CourseReport"
  ADD CONSTRAINT "CourseReport_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CourseReport"
  ADD CONSTRAINT "CourseReport_authorCaddyId_fkey"
  FOREIGN KEY ("authorCaddyId") REFERENCES "Caddy"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
