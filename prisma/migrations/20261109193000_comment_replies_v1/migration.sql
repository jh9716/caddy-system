-- Comment replies V1. Additive only.
-- Nullable parentId: existing rows stay NULL (top-level comments). No backfill.
-- No DROP, no destructive ALTER, no INSERT/UPDATE/DELETE of existing Comment rows.
-- Production/Preview migrate deploy is NOT run in this PR.
-- Deploy order: apply this migration BEFORE releasing app code that SELECTs parentId.

ALTER TABLE "Comment" ADD COLUMN "parentId" INTEGER;

CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

CREATE INDEX "Comment_threadId_parentId_createdAt_idx"
  ON "Comment"("threadId", "parentId", "createdAt");

ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Comment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
