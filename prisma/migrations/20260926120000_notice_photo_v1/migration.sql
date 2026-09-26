-- Notice Photo Upload V1. Additive only.
-- No DROP, no destructive ALTER, no seed, no existing Notice UPDATE.
-- Production migrate deploy is NOT run in this PR.

CREATE TABLE "NoticePhoto" (
  "id" SERIAL NOT NULL,
  "noticeId" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NoticePhoto_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NoticePhoto_storageKey_key"
  ON "NoticePhoto"("storageKey");

CREATE INDEX "NoticePhoto_noticeId_sortOrder_idx"
  ON "NoticePhoto"("noticeId", "sortOrder");

ALTER TABLE "NoticePhoto"
  ADD CONSTRAINT "NoticePhoto_noticeId_fkey"
  FOREIGN KEY ("noticeId") REFERENCES "Notice"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
