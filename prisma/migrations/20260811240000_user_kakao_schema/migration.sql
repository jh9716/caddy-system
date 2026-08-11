-- User: kakaoUserId (nullable unique) + password nullable for OAuth-only users
-- Add-only / non-destructive for existing User rows (passwords kept as-is).
-- Does NOT modify OffRequest / Assignment / Caddy.
-- Does NOT DROP or alter OffRequest_caddyId_date_active_key.

-- Kakao permanent identity (numeric id as text). Multiple NULLs allowed (unlinked users).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "kakaoUserId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_kakaoUserId_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'User_kakaoUserId_key'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_kakaoUserId_key" UNIQUE ("kakaoUserId");
  END IF;
END $$;

-- OAuth-only users may have no password. Existing hashed passwords remain.
ALTER TABLE "User" ALTER COLUMN "password" DROP NOT NULL;
