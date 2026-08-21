-- Additive only: force-change flag for new password staff accounts.
-- Existing User rows keep default false (env admin / DB admin / Kakao unchanged).
-- No data UPDATE / DELETE / backfill.

ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
