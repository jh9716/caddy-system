import type { CommentTargetType, Prisma, PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import {
  CommentValidationError,
  canComposeCommentAs,
  createCommentByTarget,
  findCommentThread,
  listCommentsByTarget,
  softDeleteCommentByTarget,
  COMMENT_AUTHOR_SELECT,
} from "@/lib/commentThread";
import { parseCommentBody, toCommentPublic, type CommentPublic } from "@/lib/comment";

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
  return rows.map((row) => ({
    ...row,
    canEdit: !row.deleted && viewer.userId != null && row.authorUserId === viewer.userId,
  }));
}

export async function createFreeBoardComment(
  db: PrismaClient,
  postId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown
): Promise<FreeBoardCommentPublic> {
  const row = await createCommentByTarget(db, FREE_BOARD_COMMENT_TARGET, String(postId), auth, rawBody, (c) =>
    requireLivePost(c, postId)
  );
  return { ...row, canEdit: row.authorUserId === auth.userId };
}

/** 수정은 댓글 작성자 본인만. 관리자도 타인 댓글은 수정할 수 없다. */
export async function updateFreeBoardComment(
  db: PrismaClient,
  postId: number,
  commentId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown
): Promise<FreeBoardCommentPublic> {
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new CommentValidationError("not_found", "Not found", 404);
  }
  const body = parseCommentBody(rawBody);
  const updated = await db.$transaction(async (tx) => {
    await requireLivePost(tx, postId);
    const thread = await findCommentThread(tx, FREE_BOARD_COMMENT_TARGET, String(postId));
    if (!thread) throw new CommentValidationError("not_found", "Not found", 404);
    const row = await tx.comment.findFirst({ where: { id: commentId, threadId: thread.id } });
    if (!row || row.deletedAt) throw new CommentValidationError("not_found", "Not found", 404);
    if (auth.userId == null || row.authorUserId !== auth.userId) {
      throw new CommentValidationError("forbidden", "본인 댓글만 수정할 수 있습니다.", 403);
    }
    return tx.comment.update({
      where: { id: row.id },
      data: { body },
      include: { author: { select: COMMENT_AUTHOR_SELECT } },
    });
  });
  return { ...toCommentPublic(updated, auth), canEdit: true };
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
