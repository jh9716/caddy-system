import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CommentValidationError,
  createCourseReportComment,
  listCourseReportComments,
} from "@/lib/courseReportComments";
import { readCommentWritePayload } from "@/lib/comment";
import {
  isCourseReportAuthResponse,
  requireCourseReportReader,
} from "@/lib/courseReportAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function reportId(
  params: Promise<{ id: string }> | { id: string }
): Promise<number> {
  const resolved = await Promise.resolve(params);
  return Number(resolved.id);
}

function fail(e: unknown) {
  if (e instanceof CommentValidationError) {
    return NextResponse.json(
      { error: e.code, message: e.message },
      { status: e.status }
    );
  }
  throw e;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireCourseReportReader(req);
  if (isCourseReportAuthResponse(auth)) return auth;
  try {
    const comments = await listCourseReportComments(
      prisma,
      await reportId(params),
      auth
    );
    return NextResponse.json({ comments });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireCourseReportReader(req);
  if (isCourseReportAuthResponse(auth)) return auth;
  const payload = await req.json().catch(() => ({}));
  try {
    const write = readCommentWritePayload(payload);
    const comment = await createCourseReportComment(
      prisma,
      await reportId(params),
      auth,
      write.body,
      write.parentId
    );
    return NextResponse.json({ comment }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
