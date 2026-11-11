import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { isNoticeAuthResponse, requireNoticeAdmin } from "@/lib/noticeAccess";
import { NoticeFileValidationError, abortNoticeFileUpload } from "@/lib/noticeFile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function noticeId(
  params: Promise<{ id: string }> | { id: string }
): Promise<number> {
  const resolved = await Promise.resolve(params);
  return Number(resolved.id);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireNoticeAdmin(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const id = await noticeId(params);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = (await req.json().catch(() => null)) as { grant?: unknown } | null;
    const grant = typeof body?.grant === "string" ? body.grant : "";
    const result = await abortNoticeFileUpload(prisma, {
      noticeId: id,
      grant,
      auth,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof NoticeFileValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
