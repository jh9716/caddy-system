-- CourseReport Photo Upload V1. Additive only.
-- No DROP, no destructive ALTER, no seed, no existing row UPDATE.
-- Production migrate deploy is NOT run in this PR.

CREATE TABLE "CourseReportPhoto" (
  "id" SERIAL NOT NULL,
  "reportId" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CourseReportPhoto_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseReportPhoto_storageKey_key"
  ON "CourseReportPhoto"("storageKey");

CREATE INDEX "CourseReportPhoto_reportId_sortOrder_idx"
  ON "CourseReportPhoto"("reportId", "sortOrder");

ALTER TABLE "CourseReportPhoto"
  ADD CONSTRAINT "CourseReportPhoto_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "CourseReport"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
