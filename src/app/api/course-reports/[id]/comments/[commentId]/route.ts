import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CommentValidationError,
  softDeleteCourseReportComment,
} from "@/lib/courseReportComments";
import {
  isCourseReportAuthResponse,
  requireCourseReportReader,
} from "@/lib/courseReportAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  {
    params,
  }: {
    params:
      | Promise<{ id: string; commentId: string }>
      | { id: string; commentId: string };
  }
) {
  const auth = await requireCourseReportReader(req);
  if (isCourseReportAuthResponse(auth)) return auth;
  const resolved = await Promise.resolve(params);
  try {
    await softDeleteCourseReportComment(
      prisma,
      Number(resolved.id),
      Number(resolved.commentId),
      auth
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CommentValidationError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    throw e;
  }
}
