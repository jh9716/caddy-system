-- Chat Photo Phase 1. Bytes stay in private object storage.
-- Production migrate is out of scope for this PR (Draft / MERGE HOLD).

CREATE TABLE "ChatAttachment" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "senderUserId" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "ChatAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatAttachment_storageKey_key" ON "ChatAttachment"("storageKey");
CREATE INDEX "ChatAttachment_roomId_createdAt_idx" ON "ChatAttachment"("roomId", "createdAt");
CREATE INDEX "ChatAttachment_senderUserId_consumedAt_idx" ON "ChatAttachment"("senderUserId", "consumedAt");
