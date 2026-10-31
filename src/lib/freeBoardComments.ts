import type { CommentTargetType, Prisma, PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import {
  CommentValidationError,
  canComposeCommentAs,
  createCommentByTarget,
  listCommentsByTarget,
  softDeleteCommentByTarget,
  type CommentPublic,
} from "@/lib/commentThread";

export { CommentValidationError, canComposeCommentAs };
export type { CommentPublic };

/** 기존 공용 댓글(CommentThread/Comment) 재사용. targetKey = 게시글 id. */
export const FREE_BOARD_COMMENT_TARGET = "FREE_BOARD_POST" as CommentTargetType;

async function requireLivePost(db: PrismaClient | Prisma.TransactionClient, postId: number) {
  if (!Number.isInteger(postId) || postId <= 0) {
    throw new CommentValidationError("not_found", "Not found", 404);
  }
  const post = await db.freeBoardPost.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true },
  });
  if (!post) throw new CommentValidationError("not_found", "Not found", 404);
  return post;
}

export function listFreeBoardComments(
  db: PrismaClient,
  postId: number,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null }
): Promise<CommentPublic[]> {
  return listCommentsByTarget(db, FREE_BOARD_COMMENT_TARGET, String(postId), viewer, (c) =>
    requireLivePost(c, postId)
  );
}

export function createFreeBoardComment(
  db: PrismaClient,
  postId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown
): Promise<CommentPublic> {
  return createCommentByTarget(db, FREE_BOARD_COMMENT_TARGET, String(postId), auth, rawBody, (c) =>
    requireLivePost(c, postId)
  );
}

/** 삭제: 작성자 본인 또는 관리자 (기존 canSoftDeleteComment 정책). */
export function softDeleteFreeBoardComment(
  db: PrismaClient,
  postId: number,
  commentId: number,
  auth: ResolvedAuthUser
): Promise<void> {
  return softDeleteCommentByTarget(
    db,
    FREE_BOARD_COMMENT_TARGET,
    String(postId),
    commentId,
    auth,
    (c) => requireLivePost(c, postId)
  );
}
