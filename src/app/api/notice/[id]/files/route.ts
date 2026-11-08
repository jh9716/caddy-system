import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import {
  isNoticeAuthResponse,
  requireNoticeAdmin,
} from "@/lib/noticeAccess";
import { uploadNoticeFile, NoticeFileValidationError } from "@/lib/noticeFile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function noticeId(
  params: Promise<{ id: string }> | { id: string }
): Promise<number> {
  const resolved = await Promise.resolve(params);
  return Number(resolved.id);
}

async function readUpload(req: NextRequest): Promise<{ bytes: Uint8Array; originalName: string }> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      throw new NoticeFileValidationError("empty_file", "PDF 파일이 필요합니다.");
    }
    const originalName =
      file instanceof File && typeof file.name === "string" ? file.name : "attachment.pdf";
    return { bytes: new Uint8Array(await file.arrayBuffer()), originalName };
  }
  const buf = await req.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0) {
    throw new NoticeFileValidationError("empty_file", "PDF 파일이 필요합니다.");
  }
  return { bytes: new Uint8Array(buf), originalName: "attachment.pdf" };
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
    const { bytes, originalName } = await readUpload(req);
    const file = await uploadNoticeFile(prisma, {
      noticeId: id,
      bytes,
      originalName,
      auth,
    });
    return NextResponse.json({ ok: true, file });
  } catch (e) {
    if (e instanceof NoticeFileValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
