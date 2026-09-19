import type { CommentTargetType, Prisma, PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import {
  CommentValidationError,
  canComposeComment,
  canSoftDeleteComment,
  createCommentByTarget,
  listCommentsByTarget,
  softDeleteCommentByTarget,
  type CommentPublic,
} from "@/lib/commentThread";
import { COMMENT_TARGET } from "@/lib/commentConstants";

export { CommentValidationError, canComposeComment, canSoftDeleteComment };
export type { CommentPublic };

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

function courseReportTarget(reportId: number) {
  return {
    targetType: COMMENT_TARGET.COURSE_REPORT as CommentTargetType,
    targetKey: String(reportId),
  };
}

export async function listCourseReportComments(
  db: PrismaClient,
  reportId: number,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null }
): Promise<CommentPublic[]> {
  const { targetType, targetKey } = courseReportTarget(reportId);
  return listCommentsByTarget(db, targetType, targetKey, viewer, (client) =>
    requireLiveCourseReport(client, reportId)
  );
}

export async function createCourseReportComment(
  db: PrismaClient,
  reportId: number,
  auth: ResolvedAuthUser,
  rawBody: unknown
): Promise<CommentPublic> {
  const { targetType, targetKey } = courseReportTarget(reportId);
  return createCommentByTarget(
    db,
    targetType,
    targetKey,
    auth,
    rawBody,
    (client) => requireLiveCourseReport(client, reportId)
  );
}

export async function softDeleteCourseReportComment(
  db: PrismaClient,
  reportId: number,
  commentId: number,
  auth: ResolvedAuthUser
): Promise<void> {
  const { targetType, targetKey } = courseReportTarget(reportId);
  return softDeleteCommentByTarget(
    db,
    targetType,
    targetKey,
    commentId,
    auth,
    (client) => requireLiveCourseReport(client, reportId)
  );
}
