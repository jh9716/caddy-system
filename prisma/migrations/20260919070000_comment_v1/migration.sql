-- Common Comments V1. Additive only.
-- No DROP, no destructive ALTER, no seed, no existing row UPDATE/DELETE.
-- Production migrate deploy is NOT run in this PR.

CREATE TYPE "CommentTargetType" AS ENUM ('COURSE_REPORT', 'BOARD_DATE', 'NOTICE');

CREATE TABLE "CommentThread" (
  "id" SERIAL NOT NULL,
  "targetType" "CommentTargetType" NOT NULL,
  "targetKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CommentThread_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommentThread_targetType_targetKey_key"
  ON "CommentThread"("targetType", "targetKey");

CREATE INDEX "CommentThread_targetType_targetKey_idx"
  ON "CommentThread"("targetType", "targetKey");

CREATE TABLE "Comment" (
  "id" SERIAL NOT NULL,
  "threadId" INTEGER NOT NULL,
  "authorUserId" INTEGER NOT NULL,
  "body" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Comment_threadId_createdAt_idx"
  ON "Comment"("threadId", "createdAt");

CREATE INDEX "Comment_authorUserId_idx"
  ON "Comment"("authorUserId");

ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "CommentThread"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
