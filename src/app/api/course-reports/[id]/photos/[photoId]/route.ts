import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isCourseReportAuthResponse,
  requireCourseReportReader,
  requireCourseReportWriter,
} from "@/lib/courseReportAccess";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import {
  deleteCourseReportPhoto,
  loadCourseReportPhotoMeta,
  openCourseReportPhotoBody,
} from "@/lib/courseReportPhoto";
import {
  formatPhotoServerTiming,
  photoObjectToResponseBody,
  privatePhotoBodyHeaders,
} from "@/lib/photoObjectBody";
import {
  buildPrivatePhotoETag,
  ifNoneMatchContains,
  privatePhotoCacheHeaders,
} from "@/lib/privatePhotoCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function ids(
  params: Promise<{ id: string; photoId: string }> | { id: string; photoId: string }
): Promise<{ reportId: number; photoId: number }> {
  const resolved = await Promise.resolve(params);
  return {
    reportId: Number(resolved.id),
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
  const started = performance.now();
  const auth = await requireCourseReportReader(req);
  const authMs = performance.now() - started;
  if (isCourseReportAuthResponse(auth)) return auth;

  const { reportId, photoId } = await ids(params);
  if (
    !Number.isInteger(reportId) ||
    reportId <= 0 ||
    !Number.isInteger(photoId) ||
    photoId <= 0
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const afterAuth = performance.now();
    const photo = await loadCourseReportPhotoMeta(prisma, {
      reportId,
      photoId,
    });
    const dbMs = performance.now() - afterAuth;
    const etag = buildPrivatePhotoETag("r", photo);
    const timing = formatPhotoServerTiming({ auth: authMs, db: dbMs });
    if (ifNoneMatchContains(req.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ...privatePhotoCacheHeaders(etag),
          "Server-Timing": timing,
        },
      });
    }
    const blobStarted = performance.now();
    const body = await openCourseReportPhotoBody(photo.storageKey);
    const blobOpenMs = performance.now() - blobStarted;
    return new NextResponse(photoObjectToResponseBody(body), {
      status: 200,
      headers: privatePhotoBodyHeaders(etag, photo.mimeType, photo.size, {
        "Server-Timing": formatPhotoServerTiming({
          auth: authMs,
          db: dbMs,
          blob_open: blobOpenMs,
        }),
      }),
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
  const auth = await requireCourseReportWriter(req);
  if (isCourseReportAuthResponse(auth)) return auth;

  const { reportId, photoId } = await ids(params);
  if (
    !Number.isInteger(reportId) ||
    reportId <= 0 ||
    !Number.isInteger(photoId) ||
    photoId <= 0
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await deleteCourseReportPhoto(prisma, { reportId, photoId, auth });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
