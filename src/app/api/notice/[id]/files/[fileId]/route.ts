import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import {
  isNoticeAuthResponse,
  loadNoticeViewer,
  requireNoticeAdmin,
  requireNoticeReader,
} from "@/lib/noticeAccess";
import {
  NoticeFileValidationError,
  deleteNoticeFile,
  loadNoticeFileMeta,
  noticeFileContentDisposition,
  openNoticeFileBody,
} from "@/lib/noticeFile";
import {
  canInlineNoticeFile,
  noticeFileExtFromMime,
} from "@/lib/noticeFileConstants";
import {
  formatPhotoServerTiming,
  photoObjectToResponseBody,
  privatePhotoStreamHeaders,
} from "@/lib/photoObjectBody";
import {
  buildPrivatePhotoETag,
  ifNoneMatchContains,
  privatePhotoCacheHeaders,
} from "@/lib/privatePhotoCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function ids(
  params: Promise<{ id: string; fileId: string }> | { id: string; fileId: string }
): Promise<{ noticeId: number; fileId: number }> {
  const resolved = await Promise.resolve(params);
  return {
    noticeId: Number(resolved.id),
    fileId: Number(resolved.fileId),
  };
}

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string; fileId: string }> | { id: string; fileId: string };
  }
) {
  const started = performance.now();
  const auth = await requireNoticeReader(req);
  const authMs = performance.now() - started;
  if (isNoticeAuthResponse(auth)) return auth;

  const { noticeId, fileId } = await ids(params);
  if (
    !Number.isInteger(noticeId) ||
    noticeId <= 0 ||
    !Number.isInteger(fileId) ||
    fileId <= 0
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const afterAuth = performance.now();
    const viewer = await loadNoticeViewer(prisma, auth);
    const file = await loadNoticeFileMeta(prisma, {
      noticeId,
      fileId,
      viewer,
    });
    const dbMs = performance.now() - afterAuth;
    const etag = buildPrivatePhotoETag("nf", file);
    const timing = formatPhotoServerTiming({ auth: authMs, db: dbMs });
    const download = req.nextUrl.searchParams.get("download") === "1";
    const inline = !download && canInlineNoticeFile(file.mimeType);
    const disposition = noticeFileContentDisposition(
      file.originalName,
      inline ? "inline" : "attachment",
      noticeFileExtFromMime(file.mimeType)
    );
    if (ifNoneMatchContains(req.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ...privatePhotoCacheHeaders(etag),
          "Content-Disposition": disposition,
          "Server-Timing": timing,
        },
      });
    }
    const blobStarted = performance.now();
    const body = await openNoticeFileBody(file.storageKey, req.signal);
    const blobOpenMs = performance.now() - blobStarted;
    return new NextResponse(photoObjectToResponseBody(body), {
      status: 200,
      headers: {
        ...privatePhotoStreamHeaders(etag, file.mimeType, body, {
          "Server-Timing": formatPhotoServerTiming({
            auth: authMs,
            db: dbMs,
            blob_open: blobOpenMs,
          }),
        }),
        "Content-Disposition": disposition,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof NoticeFileValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string; fileId: string }> | { id: string; fileId: string };
  }
) {
  const auth = await requireNoticeAdmin(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const { noticeId, fileId } = await ids(params);
  if (
    !Number.isInteger(noticeId) ||
    noticeId <= 0 ||
    !Number.isInteger(fileId) ||
    fileId <= 0
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const result = await deleteNoticeFile(prisma, { noticeId, fileId, auth });
    return NextResponse.json({
      ok: true,
      ...(result.blobCleanupFailed ? { blobCleanupFailed: true } : {}),
    });
  } catch (e) {
    if (e instanceof NoticeFileValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
