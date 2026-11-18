-- Team affiliation settings (HOUSE/THIRD + operational) by effective date.
-- Additive only. No Caddy UPDATE, no published board rewrite, no seed of 2026-11-16 ops change.
-- Production/Preview migrate deploy is NOT run in this PR.
-- App code falls back to 1~8 HOUSE / 9~12 THIRD when this table is missing.

CREATE TABLE "TeamAffiliationVersion" (
    "id" SERIAL NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" INTEGER,

    CONSTRAINT "TeamAffiliationVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamAffiliationVersion_effectiveFrom_key" ON "TeamAffiliationVersion"("effectiveFrom");
CREATE INDEX "TeamAffiliationVersion_effectiveFrom_idx" ON "TeamAffiliationVersion"("effectiveFrom");

CREATE TABLE "TeamAffiliationItem" (
    "id" SERIAL NOT NULL,
    "versionId" INTEGER NOT NULL,
    "team" TEXT NOT NULL,
    "affiliation" "CaddyType" NOT NULL,
    "operational" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TeamAffiliationItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamAffiliationItem_versionId_team_key" ON "TeamAffiliationItem"("versionId", "team");
CREATE INDEX "TeamAffiliationItem_team_idx" ON "TeamAffiliationItem"("team");

ALTER TABLE "TeamAffiliationItem"
  ADD CONSTRAINT "TeamAffiliationItem_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "TeamAffiliationVersion"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
