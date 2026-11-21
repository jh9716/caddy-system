/**
 * 커뮤니티 자유게시판 댓글·답글. 기존 공용 댓글(CommentThread/Comment, 1단계 답글) 재사용.
 * targetType = COMMUNITY_POST (가배치표 FREE_BOARD_POST 와 분리), targetKey = CommunityPost.id.
 * 정책(기존과 동일): 작성 = 로그인 정상 계정, 수정 = 작성자 본인만, 삭제 = 작성자 본인 또는 관리자.
 */
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
import { COMMUNITY_FREE_BOARD_TYPE } from "@/lib/communityBoard";

export { CommentValidationError, canComposeCommentAs };

export type CommunityCommentPublic = CommentPublic & { canEdit: boolean };

export const COMMUNITY_COMMENT_TARGET = "COMMUNITY_POST" as CommentTargetType;

async function requireLivePost(db: PrismaClient | Prisma.TransactionClient, postId: number) {
  if (!Number.isInteger(postId) || postId <= 0) {
    throw new CommentValidationError("not_found", "Not found", 404);
  }
  const post = await db.communityPost.findFirst({
    where: { id: postId, boardType: COMMUNITY_FREE_BOARD_TYPE, deletedAt: null },
    select: { id: true },
  });
  if (!post) throw new CommentValidationError("not_found", "Not found", 404);
  return post;
}

export async function listCommunityComments(
  db: PrismaClient,
  postId: number,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null }
): Promise<CommunityCommentPublic[]> {
  const rows = await listCommentsByTarget(db, COMMUNITY_COMMENT_TARGET, String(postId), viewer, (c) =>
    requireLivePost(c, postId)
  );
  return rows.map((row) => ({ ...row, canEdit: row.canEdit === true }));
}

export async function createCommunityComment(
  db: PrismaClient,
  postId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown,
  rawParentId?: unknown
): Promise<CommunityCommentPublic> {
  const row = await createCommentByTarget(
    db,
    COMMUNITY_COMMENT_TARGET,
    String(postId),
    auth,
    rawBody,
    (c) => requireLivePost(c, postId),
    rawParentId
  );
  return { ...row, canEdit: row.canEdit === true };
}

export async function updateCommunityComment(
  db: PrismaClient,
  postId: number,
  commentId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown
): Promise<CommunityCommentPublic> {
  const row = await updateCommentByTarget(
    db,
    COMMUNITY_COMMENT_TARGET,
    String(postId),
    commentId,
    auth,
    rawBody,
    (c) => requireLivePost(c, postId)
  );
  return { ...row, canEdit: row.canEdit === true };
}

export function softDeleteCommunityComment(
  db: PrismaClient,
  postId: number,
  commentId: number,
  auth: ResolvedAuthUser
): Promise<void> {
  return softDeleteCommentByTarget(db, COMMUNITY_COMMENT_TARGET, String(postId), commentId, auth, (c) =>
    requireLivePost(c, postId)
  );
}
