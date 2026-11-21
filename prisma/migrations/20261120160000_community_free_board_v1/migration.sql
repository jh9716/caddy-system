-- 커뮤니티 자유게시판 V1 (additive only).
-- 새 enum / 새 테이블 2개 / 기존 enum 값 1개 추가만 한다.
-- 기존 테이블(FreeBoardPost·FreeBoardPhoto = 가배치표 등)·기존 행은 변경·삭제·재분류하지 않는다.
-- 원격 DB(Preview·Production) 실행은 별도 승인 후에만.

-- AlterEnum (additive)
ALTER TYPE "CommentTargetType" ADD VALUE IF NOT EXISTS 'COMMUNITY_POST';

-- CreateEnum
CREATE TYPE "CommunityBoardType" AS ENUM ('FREE');

-- CreateTable
CREATE TABLE "CommunityPost" (
    "id" SERIAL NOT NULL,
    "boardType" "CommunityBoardType" NOT NULL DEFAULT 'FREE',
    "authorUserId" INTEGER NOT NULL,
    "authorDisplayName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityPhoto" (
    "id" SERIAL NOT NULL,
    "postId" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunityPost_boardType_deletedAt_createdAt_idx" ON "CommunityPost"("boardType", "deletedAt", "createdAt");
CREATE INDEX "CommunityPost_authorUserId_idx" ON "CommunityPost"("authorUserId");
CREATE UNIQUE INDEX "CommunityPhoto_storageKey_key" ON "CommunityPhoto"("storageKey");
CREATE INDEX "CommunityPhoto_postId_sortOrder_idx" ON "CommunityPhoto"("postId", "sortOrder");

-- AddForeignKey
ALTER TABLE "CommunityPost" ADD CONSTRAINT "CommunityPost_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommunityPhoto" ADD CONSTRAINT "CommunityPhoto_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CommunityPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
