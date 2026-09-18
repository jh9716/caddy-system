import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CourseReportValidationError,
  parseCourseReportStatusBody,
  resolvedAtForStatus,
  toCourseReportPublic,
} from "@/lib/courseReport";
import {
  canChangeCourseReportStatus,
  isCourseReportAuthResponse,
  requireCourseReportReader,
} from "@/lib/courseReportAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function reportId(
  params: Promise<{ id: string }> | { id: string }
): Promise<number> {
  const resolved = await Promise.resolve(params);
  return Number(resolved.id);
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
  if (!canChangeCourseReportStatus({ role: auth.role, deletedAt: existing.deletedAt })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  try {
    const status = parseCourseReportStatusBody(body);
    const updated = await prisma.courseReport.update({
      where: { id },
      data: {
        status,
        resolvedAt: resolvedAtForStatus(status),
        handlerUserId: auth.userId,
      },
    });
    return NextResponse.json(toCourseReportPublic(updated));
  } catch (e) {
    if (e instanceof CourseReportValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
