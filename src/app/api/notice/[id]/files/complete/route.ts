import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { isNoticeAuthResponse, requireNoticeAdmin } from "@/lib/noticeAccess";
import { parseRequestedSortOrder } from "@/lib/noticeMediaLock";
import { NoticeFileValidationError, completeNoticeFileUpload } from "@/lib/noticeFile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

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
      grant?: unknown;
      originalName?: unknown;
      sortOrder?: unknown;
    } | null;
    const grant = typeof body?.grant === "string" ? body.grant : "";
    const file = await completeNoticeFileUpload(prisma, {
      noticeId: id,
      grant,
      originalName: typeof body?.originalName === "string" ? body.originalName : null,
      auth,
      requestedSortOrder: parseRequestedSortOrder(
        typeof body?.sortOrder === "string" || typeof body?.sortOrder === "number"
          ? String(body.sortOrder)
          : null
      ),
    });
    return NextResponse.json({ ok: true, file });
  } catch (e) {
    if (e instanceof NoticeFileValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
