-- Notice PDF attachment V1. Additive only.
-- Separate from NoticePhoto. No DROP, no destructive ALTER, no seed,
-- no existing Notice / NoticePhoto UPDATE.
-- Production / Preview migrate deploy is NOT run in this PR.

CREATE TABLE "NoticeFile" (
  "id" SERIAL NOT NULL,
  "noticeId" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NoticeFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NoticeFile_storageKey_key"
  ON "NoticeFile"("storageKey");

CREATE INDEX "NoticeFile_noticeId_sortOrder_idx"
  ON "NoticeFile"("noticeId", "sortOrder");

ALTER TABLE "NoticeFile"
  ADD CONSTRAINT "NoticeFile_noticeId_fkey"
  FOREIGN KEY ("noticeId") REFERENCES "Notice"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
