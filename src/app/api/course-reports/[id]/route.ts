import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CourseReportValidationError,
  parseCourseReportUpdateBody,
  toCourseReportPublic,
} from "@/lib/courseReport";
import {
  canEditCourseReportContent,
  canSoftDeleteCourseReport,
  isCourseReportAuthResponse,
  requireCourseReportReader,
} from "@/lib/courseReportAccess";
import { findCourseReportWithPhotos } from "@/lib/courseReportPhoto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function reportId(
  params: Promise<{ id: string }> | { id: string }
): Promise<number> {
  const resolved = await Promise.resolve(params);
  return Number(resolved.id);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireCourseReportReader(req);
  if (isCourseReportAuthResponse(auth)) return auth;

  const id = await reportId(params);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const loaded = await findCourseReportWithPhotos(prisma, id);
  if (!loaded) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    ...toCourseReportPublic(loaded.report, loaded.photos.length),
    photos: loaded.photos,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireCourseReportReader(req);
  if (isCourseReportAuthResponse(auth)) return auth;

  const id = await reportId(params);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const existing = await prisma.courseReport.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (
    !canEditCourseReportContent({
      role: auth.role,
      userId: auth.userId,
      authorUserId: existing.authorUserId,
      status: existing.status,
      deletedAt: existing.deletedAt,
    })
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  try {
    const parsed = parseCourseReportUpdateBody(body);
    const updated = await prisma.courseReport.update({
      where: { id },
      data: parsed,
    });
    return NextResponse.json(toCourseReportPublic(updated));
  } catch (e) {
    if (e instanceof CourseReportValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireCourseReportReader(req);
  if (isCourseReportAuthResponse(auth)) return auth;

  const id = await reportId(params);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const existing = await prisma.courseReport.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (
    !canSoftDeleteCourseReport({
      role: auth.role,
      userId: auth.userId,
      authorUserId: existing.authorUserId,
      status: existing.status,
      deletedAt: existing.deletedAt,
    })
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await prisma.courseReport.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
