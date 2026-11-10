import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { isNoticeAuthResponse, requireNoticeAdmin } from "@/lib/noticeAccess";
import { NoticeFileValidationError, prepareNoticeFileUpload } from "@/lib/noticeFile";

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
    const body = (await req.json().catch(() => null)) as {
      originalName?: unknown;
      contentType?: unknown;
      size?: unknown;
    } | null;
    const upload = await prepareNoticeFileUpload(prisma, {
      noticeId: id,
      originalName: typeof body?.originalName === "string" ? body.originalName : null,
      contentType: typeof body?.contentType === "string" ? body.contentType : null,
      size: body?.size,
      auth,
    });
    return NextResponse.json({ ok: true, upload });
  } catch (e) {
    if (e instanceof NoticeFileValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
