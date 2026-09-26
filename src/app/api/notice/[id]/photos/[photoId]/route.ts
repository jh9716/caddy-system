import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import {
  isNoticeAuthResponse,
  loadNoticeViewer,
  requireNoticeAdmin,
  requireNoticeReader,
} from "@/lib/noticeAccess";
import { deleteNoticePhoto, loadNoticePhotoBytes } from "@/lib/noticePhoto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function ids(
  params: Promise<{ id: string; photoId: string }> | { id: string; photoId: string }
): Promise<{ noticeId: number; photoId: number }> {
  const resolved = await Promise.resolve(params);
  return {
    noticeId: Number(resolved.id),
    photoId: Number(resolved.photoId),
  };
}

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string; photoId: string }> | { id: string; photoId: string };
  }
) {
  const auth = await requireNoticeReader(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const { noticeId, photoId } = await ids(params);
  if (
    !Number.isInteger(noticeId) ||
    noticeId <= 0 ||
    !Number.isInteger(photoId) ||
    photoId <= 0
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const viewer = await loadNoticeViewer(prisma, auth);
    const { mimeType, bytes } = await loadNoticePhotoBytes(prisma, {
      noticeId,
      photoId,
      viewer,
    });
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
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
    params: Promise<{ id: string; photoId: string }> | { id: string; photoId: string };
  }
) {
  const auth = await requireNoticeAdmin(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const { noticeId, photoId } = await ids(params);
  if (
    !Number.isInteger(noticeId) ||
    noticeId <= 0 ||
    !Number.isInteger(photoId) ||
    photoId <= 0
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const result = await deleteNoticePhoto(prisma, { noticeId, photoId, auth });
    return NextResponse.json({
      ok: true,
      ...(result.blobCleanupFailed ? { blobCleanupFailed: true } : {}),
    });
  } catch (e) {
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
