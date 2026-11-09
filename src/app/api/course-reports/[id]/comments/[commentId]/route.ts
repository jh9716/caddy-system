import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CommentValidationError,
  softDeleteCourseReportComment,
  updateCourseReportComment,
} from "@/lib/courseReportComments";
import {
  isCourseReportAuthResponse,
  requireCourseReportReader,
} from "@/lib/courseReportAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 댓글 수정 — 작성자 본인만 (서버 검증). body: { body: string } */
export async function PATCH(
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
  const payload = await req.json().catch(() => ({}));
  try {
    const comment = await updateCourseReportComment(
      prisma,
      Number(resolved.id),
      Number(resolved.commentId),
      auth,
      payload && typeof payload === "object"
        ? (payload as { body?: unknown }).body
        : undefined
    );
    return NextResponse.json({ comment });
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
