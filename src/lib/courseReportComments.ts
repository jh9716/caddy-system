import type { CommentTargetType, Prisma, PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import {
  CommentValidationError,
  canComposeComment,
  canSoftDeleteComment,
  isCommentTableMissing,
  isCommentUniqueConflict,
  parseCommentBody,
  toCommentPublic,
  type CommentPublic,
} from "@/lib/comment";
import { COMMENT_TARGET } from "@/lib/commentConstants";

export { CommentValidationError, canComposeComment, canSoftDeleteComment };

const AUTHOR_SELECT = {
  username: true,
  caddy: { select: { name: true } },
} as const;

function commentsUnavailable(): never {
  throw new CommentValidationError(
    "comments_unavailable",
    "댓글 기능이 아직 준비되지 않았습니다.",
    503
  );
}

async function requireLiveCourseReport(
  db: PrismaClient | Prisma.TransactionClient,
  reportId: number
) {
  if (!Number.isInteger(reportId) || reportId <= 0) {
    throw new CommentValidationError("not_found", "Not found", 404);
  }
  const report = await db.courseReport.findFirst({
    where: { id: reportId, deletedAt: null },
    select: { id: true },
  });
  if (!report) {
    throw new CommentValidationError("not_found", "Not found", 404);
  }
  return report;
}

async function findCourseReportThread(
  db: PrismaClient | Prisma.TransactionClient,
  reportId: number
) {
  return db.commentThread.findUnique({
    where: {
      targetType_targetKey: {
        targetType: COMMENT_TARGET.COURSE_REPORT,
        targetKey: String(reportId),
      },
    },
  });
}

async function getOrCreateCourseReportThread(
  tx: Prisma.TransactionClient,
  reportId: number
) {
  const targetType = COMMENT_TARGET.COURSE_REPORT as CommentTargetType;
  const targetKey = String(reportId);
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

export async function listCourseReportComments(
  db: PrismaClient,
  reportId: number,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null }
): Promise<CommentPublic[]> {
  try {
    await requireLiveCourseReport(db, reportId);
    const thread = await findCourseReportThread(db, reportId);
    if (!thread) return [];
    const rows = await db.comment.findMany({
      where: { threadId: thread.id },
      include: { author: { select: AUTHOR_SELECT } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => toCommentPublic(row, viewer));
  } catch (e) {
    if (e instanceof CommentValidationError) throw e;
    if (isCommentTableMissing(e)) return [];
    throw e;
  }
}

export async function createCourseReportComment(
  db: PrismaClient,
  reportId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown
): Promise<CommentPublic> {
  if (!canComposeComment(auth) || auth.userId == null) {
    throw new CommentValidationError(
      "author_required",
      "작성자 계정이 필요합니다.",
      403
    );
  }
  const body = parseCommentBody(rawBody);
  const authorUserId = auth.userId;
  try {
    const created = await db.$transaction(async (tx) => {
      await requireLiveCourseReport(tx, reportId);
      const thread = await getOrCreateCourseReportThread(tx, reportId);
      return tx.comment.create({
        data: {
          threadId: thread.id,
          authorUserId,
          body,
        },
        include: { author: { select: AUTHOR_SELECT } },
      });
    });
    return toCommentPublic(created, auth);
  } catch (e) {
    if (e instanceof CommentValidationError) throw e;
    if (isCommentTableMissing(e)) commentsUnavailable();
    throw e;
  }
}

export async function softDeleteCourseReportComment(
  db: PrismaClient,
  reportId: number,
  commentId: number,
  auth: ResolvedAuthUser
): Promise<void> {
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new CommentValidationError("not_found", "Not found", 404);
  }
  try {
    await db.$transaction(async (tx) => {
      await requireLiveCourseReport(tx, reportId);
      const thread = await findCourseReportThread(tx, reportId);
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
