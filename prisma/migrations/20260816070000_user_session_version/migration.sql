-- User signed-session invalidation counter (additive only).
-- Production: apply migrate deploy BEFORE deploying app code that requires this column.
-- No data UPDATE / DELETE / backfill.

ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
