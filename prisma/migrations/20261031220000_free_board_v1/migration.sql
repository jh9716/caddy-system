-- 자유게시판 V1 (additive only). 기존 테이블/데이터 변경 없음.
-- 실행은 Preview DB 먼저, Production 은 별도 승인 후.

-- AlterEnum (additive)
ALTER TYPE "CommentTargetType" ADD VALUE IF NOT EXISTS 'FREE_BOARD_POST';

-- CreateTable
CREATE TABLE "FreeBoardPost" (
    "id" SERIAL NOT NULL,
    "authorUserId" INTEGER NOT NULL,
    "authorDisplayName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeBoardPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreeBoardPhoto" (
    "id" SERIAL NOT NULL,
    "postId" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreeBoardPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FreeBoardPost_deletedAt_createdAt_idx" ON "FreeBoardPost"("deletedAt", "createdAt");
CREATE INDEX "FreeBoardPost_authorUserId_idx" ON "FreeBoardPost"("authorUserId");
CREATE UNIQUE INDEX "FreeBoardPhoto_storageKey_key" ON "FreeBoardPhoto"("storageKey");
CREATE INDEX "FreeBoardPhoto_postId_sortOrder_idx" ON "FreeBoardPhoto"("postId", "sortOrder");

-- AddForeignKey
ALTER TABLE "FreeBoardPost" ADD CONSTRAINT "FreeBoardPost_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FreeBoardPhoto" ADD CONSTRAINT "FreeBoardPhoto_postId_fkey" FOREIGN KEY ("postId") REFERENCES "FreeBoardPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
