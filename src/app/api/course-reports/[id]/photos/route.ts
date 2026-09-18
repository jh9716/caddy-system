import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isCourseReportAuthResponse,
  requireCourseReportWriter,
} from "@/lib/courseReportAccess";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { uploadCourseReportPhoto } from "@/lib/courseReportPhoto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function reportId(
  params: Promise<{ id: string }> | { id: string }
): Promise<number> {
  const resolved = await Promise.resolve(params);
  return Number(resolved.id);
}

async function readUploadBytes(req: NextRequest): Promise<Uint8Array> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
    }
    return new Uint8Array(await file.arrayBuffer());
  }
  const buf = await req.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0) {
    throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  return new Uint8Array(buf);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireCourseReportWriter(req);
  if (isCourseReportAuthResponse(auth)) return auth;

  const id = await reportId(params);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const bytes = await readUploadBytes(req);
    const photo = await uploadCourseReportPhoto(prisma, { reportId: id, bytes, auth });
    return NextResponse.json({ ok: true, photo });
  } catch (e) {
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
