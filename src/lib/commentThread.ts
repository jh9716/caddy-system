import type { CommentTargetType, Prisma, PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import {
  CommentValidationError,
  canComposeComment,
  canComposeCommentAs,
  canSoftDeleteComment,
  isCommentTableMissing,
  isCommentUniqueConflict,
  parseCommentBody,
  resolveCommentAuthorUserId,
  toCommentPublic,
  type CommentPublic,
} from "@/lib/comment";

export {
  CommentValidationError,
  canComposeComment,
  canComposeCommentAs,
  canSoftDeleteComment,
  resolveCommentAuthorUserId,
};
export type { CommentPublic };

export const COMMENT_AUTHOR_SELECT = {
  username: true,
  caddy: { select: { name: true } },
} as const;

type CommentDb = PrismaClient | Prisma.TransactionClient;

export type EnsureCommentTarget = (
  db: CommentDb
) => Promise<unknown>;

export function commentsUnavailable(): never {
  throw new CommentValidationError(
    "comments_unavailable",
    "댓글 기능이 아직 준비되지 않았습니다.",
    503
  );
}

export async function findCommentThread(
  db: CommentDb,
  targetType: CommentTargetType,
  targetKey: string
) {
  return db.commentThread.findUnique({
    where: { targetType_targetKey: { targetType, targetKey } },
  });
}

export async function getOrCreateCommentThread(
  tx: Prisma.TransactionClient,
  targetType: CommentTargetType,
  targetKey: string
) {
  const existing = await tx.commentThread.findUnique({
    where: { targetType_targetKey: { targetType, targetKey } },
  });
  if (existing) return existing;
  try {
    return await tx.commentThread.create({
      data: { targetType, targetKey },
    });
  } catch (e) {
    if (!isCommentUniqueConflict(e)) throw e;
    const raced = await tx.commentThread.findUnique({
      where: { targetType_targetKey: { targetType, targetKey } },
    });
    if (!raced) throw e;
    return raced;
  }
}

export async function listCommentsByTarget(
  db: PrismaClient,
  targetType: CommentTargetType,
  targetKey: string,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null },
  ensureTarget: EnsureCommentTarget
): Promise<CommentPublic[]> {
  try {
    await ensureTarget(db);
    const thread = await findCommentThread(db, targetType, targetKey);
    if (!thread) return [];
    const rows = await db.comment.findMany({
      where: { threadId: thread.id },
      include: { author: { select: COMMENT_AUTHOR_SELECT } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => toCommentPublic(row, viewer));
  } catch (e) {
    if (e instanceof CommentValidationError) throw e;
    if (isCommentTableMissing(e)) return [];
    throw e;
  }
}

export async function createCommentByTarget(
  db: PrismaClient,
  targetType: CommentTargetType,
  targetKey: string,
  auth: ResolvedAuthUser,
  rawBody: unknown,
  ensureTarget: EnsureCommentTarget
): Promise<CommentPublic> {
  const authorUserId = await resolveCommentAuthorUserId(db, auth);
  if (!canComposeComment({ role: auth.role, userId: authorUserId }) || authorUserId == null) {
    throw new CommentValidationError(
      "author_required",
      "작성자 계정이 필요합니다.",
      403
    );
  }
  const body = parseCommentBody(rawBody);
  try {
    const created = await db.$transaction(async (tx) => {
      await ensureTarget(tx);
      const thread = await getOrCreateCommentThread(tx, targetType, targetKey);
      return tx.comment.create({
        data: {
          threadId: thread.id,
          authorUserId,
          body,
        },
        include: { author: { select: COMMENT_AUTHOR_SELECT } },
      });
    });
    return toCommentPublic(created, auth);
  } catch (e) {
    if (e instanceof CommentValidationError) throw e;
    if (isCommentTableMissing(e)) commentsUnavailable();
    throw e;
  }
}

export async function softDeleteCommentByTarget(
  db: PrismaClient,
  targetType: CommentTargetType,
  targetKey: string,
  commentId: number,
  auth: ResolvedAuthUser,
  ensureTarget: EnsureCommentTarget
): Promise<void> {
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new CommentValidationError("not_found", "Not found", 404);
  }
  try {
    await db.$transaction(async (tx) => {
      await ensureTarget(tx);
      const thread = await findCommentThread(tx, targetType, targetKey);
      if (!thread) {
        throw new CommentValidationError("not_found", "Not found", 404);
      }
      const row = await tx.comment.findFirst({
        where: { id: commentId, threadId: thread.id },
      });
      if (!row || row.deletedAt) {
        throw new CommentValidationError("not_found", "Not found", 404);
      }
      if (
        !canSoftDeleteComment({
          role: auth.role,
          userId: auth.userId,
          authorUserId: row.authorUserId,
          deletedAt: row.deletedAt,
        })
      ) {
        throw new CommentValidationError("forbidden", "forbidden", 403);
      }
      await tx.comment.update({
        where: { id: row.id },
        data: { deletedAt: new Date() },
      });
    });
  } catch (e) {
    if (e instanceof CommentValidationError) throw e;
    if (isCommentTableMissing(e)) commentsUnavailable();
    throw e;
  }
}
