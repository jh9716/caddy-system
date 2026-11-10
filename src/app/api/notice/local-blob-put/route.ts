import { NextRequest, NextResponse } from "next/server";
import { putLocalNoticeFileBytes } from "@/lib/noticeFile";
import { assertNoticeFileGrantFresh, parseSignedNoticeFileGrant } from "@/lib/noticeFileGrant";
import { NoticeFileValidationError } from "@/lib/noticeFileMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { noticeFileSizeMessage, noticeFileTypeMessage } from "@/lib/noticeFileConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Local/dev stand-in for a Private Blob signed PUT.
 * Production/Vercel always 404 — notice file bytes never use this on Vercel.
 */
export async function PUT(req: NextRequest) {
  if (process.env.VERCEL === "1") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const token = req.nextUrl.searchParams.get("token") || "";
    const grant = parseSignedNoticeFileGrant(token);
    assertNoticeFileGrantFresh(grant);
    const contentType = (req.headers.get("content-type") || "").toLowerCase().split(";", 1)[0];
    if (contentType !== grant.contentType) {
      throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage());
    }
    const buf = await req.arrayBuffer().catch(() => null);
    if (!buf || buf.byteLength === 0) {
      throw new NoticeFileValidationError("empty_file", "첨부파일이 필요합니다.");
    }
    if (buf.byteLength > grant.maxBytes) {
      throw new NoticeFileValidationError("file_too_large", noticeFileSizeMessage());
    }
    await putLocalNoticeFileBytes({
      storageKey: grant.storageKey,
      contentType: grant.contentType,
      bytes: new Uint8Array(buf),
    });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof NoticeFileValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    console.error("[PUT /api/notice/local-blob-put]", e);
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }
}
