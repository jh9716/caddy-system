-- Notice V2 additive fields only.
-- No table/column removal, no destructive ALTER, no existing-row rewrite, no seed.
-- Production migrate deploy is NOT run in this PR.

ALTER TABLE "Notice" ADD COLUMN "important" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Notice" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Notice" ADD COLUMN "targetType" TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE "Notice" ADD COLUMN "targetValue" TEXT;
ALTER TABLE "Notice" ADD COLUMN "publishStartAt" TIMESTAMP(3);
ALTER TABLE "Notice" ADD COLUMN "publishEndAt" TIMESTAMP(3);
ALTER TABLE "Notice" ADD COLUMN "pushSentAt" TIMESTAMP(3);
ALTER TABLE "Notice" ADD COLUMN "pushSentByUserId" INTEGER;

CREATE INDEX "Notice_pinned_important_createdAt_idx" ON "Notice"("pinned", "important", "createdAt");
CREATE INDEX "Notice_targetType_targetValue_idx" ON "Notice"("targetType", "targetValue");
