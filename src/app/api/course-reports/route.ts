import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CourseReportValidationError,
  parseCourseReportCreateBody,
  parseCourseReportStatusFilter,
  resolveCourseReportAuthorSnapshot,
  toCourseReportPublic,
} from "@/lib/courseReport";
import {
  isCourseReportAuthResponse,
  requireCourseReportReader,
  requireCourseReportWriter,
} from "@/lib/courseReportAccess";
import { COURSE_REPORT_LIST_TAKE } from "@/lib/courseReportConstants";
import { listCourseReportsWithPhotoCount } from "@/lib/courseReportPhoto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireCourseReportReader(req);
  if (isCourseReportAuthResponse(auth)) return auth;

  const status = parseCourseReportStatusFilter(req.nextUrl.searchParams.get("status"));
  const list = await listCourseReportsWithPhotoCount(prisma, {
    status: status ?? undefined,
    take: COURSE_REPORT_LIST_TAKE,
  });
  return NextResponse.json(list.map(({ report, photoCount }) => toCourseReportPublic(report, photoCount)));
}

export async function POST(req: NextRequest) {
  const auth = await requireCourseReportWriter(req);
  if (isCourseReportAuthResponse(auth)) return auth;

  const body = await req.json().catch(() => ({}));
  try {
    const parsed = parseCourseReportCreateBody(body);
    const author = await resolveCourseReportAuthorSnapshot(prisma, auth);
    const created = await prisma.courseReport.create({
      data: {
        ...author,
        title: parsed.title,
        body: parsed.body,
        course: parsed.course,
        hole: parsed.hole,
        category: parsed.category,
      },
    });
    return NextResponse.json({ ok: true, id: created.id, report: toCourseReportPublic(created) });
  } catch (e) {
    if (e instanceof CourseReportValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
