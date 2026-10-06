-- Chat Photo Phase 2. Additive PENDING/READY lifecycle for direct Blob upload.
-- Existing Phase 1 rows stay READY via DEFAULT.
-- Production migrate is out of scope for this PR (Draft / MERGE HOLD).

CREATE TYPE "ChatAttachmentUploadState" AS ENUM ('PENDING', 'READY');

ALTER TABLE "ChatAttachment"
ADD COLUMN "uploadState" "ChatAttachmentUploadState" NOT NULL DEFAULT 'READY';

CREATE INDEX "ChatAttachment_uploadState_createdAt_idx"
ON "ChatAttachment"("uploadState", "createdAt");
