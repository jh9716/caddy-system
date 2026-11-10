import type { CommentTargetType, Prisma, PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import {
  CommentValidationError,
  canComposeCommentAs,
  createCommentByTarget,
  listCommentsByTarget,
  softDeleteCommentByTarget,
  updateCommentByTarget,
} from "@/lib/commentThread";
import type { CommentPublic } from "@/lib/comment";

export { CommentValidationError, canComposeCommentAs };
export type { CommentPublic };

export type FreeBoardCommentPublic = CommentPublic & { canEdit: boolean };

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

export async function listFreeBoardComments(
  db: PrismaClient,
  postId: number,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null }
): Promise<FreeBoardCommentPublic[]> {
  const rows = await listCommentsByTarget(db, FREE_BOARD_COMMENT_TARGET, String(postId), viewer, (c) =>
    requireLivePost(c, postId)
  );
  return rows.map((row) => ({ ...row, canEdit: row.canEdit === true }));
}

export async function createFreeBoardComment(
  db: PrismaClient,
  postId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown,
  rawParentId?: unknown
): Promise<FreeBoardCommentPublic> {
  const row = await createCommentByTarget(
    db,
    FREE_BOARD_COMMENT_TARGET,
    String(postId),
    auth,
    rawBody,
    (c) => requireLivePost(c, postId),
    rawParentId
  );
  return { ...row, canEdit: row.canEdit === true };
}

/** 수정은 공용 updateCommentByTarget — 작성자 본인만. 관리자도 타인 댓글은 수정할 수 없다. */
export async function updateFreeBoardComment(
  db: PrismaClient,
  postId: number,
  commentId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown
): Promise<FreeBoardCommentPublic> {
  const row = await updateCommentByTarget(
    db,
    FREE_BOARD_COMMENT_TARGET,
    String(postId),
    commentId,
    auth,
    rawBody,
    (c) => requireLivePost(c, postId)
  );
  return { ...row, canEdit: row.canEdit === true };
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
