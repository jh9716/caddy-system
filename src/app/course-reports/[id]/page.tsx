import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import dayjs from "dayjs";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { toCourseReportPublic } from "@/lib/courseReport";
import {
  canChangeCourseReportStatus,
  canEditCourseReportContent,
  canSoftDeleteCourseReport,
} from "@/lib/courseReportAccess";
import CourseReportDetailActions from "./CourseReportDetailActions";
import CourseReportPhotoGallery from "../CourseReportPhotoGallery";
import { toCourseReportPhotoPublic } from "@/lib/courseReportPhoto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CourseReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/course-reports");

  const resolved = await Promise.resolve(params);
  const id = Number(resolved.id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const row = await prisma.courseReport.findFirst({
    where: { id, deletedAt: null },
    include: { photos: { orderBy: { sortOrder: "asc" } } },
  });
  if (!row) notFound();

  const report = toCourseReportPublic(row, row.photos.length);
  const photos = row.photos.map(toCourseReportPhotoPublic);
  const editInput = {
    role: auth.role,
    userId: auth.userId,
    authorUserId: row.authorUserId,
    status: row.status,
    deletedAt: row.deletedAt,
  };

  return (
    <div className="course-report-page course-report-detail">
      <Link href="/course-reports" className="ui-btn ui-btn-ghost course-report-back">
        ← 목록
      </Link>
      <div className="course-report-detail-badges">
        <span className={`course-report-badge is-${report.status.toLowerCase()}`}>
          {report.statusLabel}
        </span>
        <span className="course-report-cat">{report.categoryLabel}</span>
      </div>
      <h1 className="ui-page-title">{report.title}</h1>
      <p className="course-report-detail-meta">
        {report.courseLabel}
        {report.hole != null ? ` ${report.hole}홀` : ""}
        <span> · {report.authorDisplayName}</span>
        <span> · {dayjs(report.createdAt).format("YYYY-MM-DD HH:mm")}</span>
      </p>
      <div className="course-report-detail-body">{report.body}</div>
      <CourseReportPhotoGallery reportId={id} photos={photos} />
      <CourseReportDetailActions
        id={id}
        canEdit={canEditCourseReportContent(editInput)}
        canDelete={canSoftDeleteCourseReport(editInput)}
        canChangeStatus={canChangeCourseReportStatus({
          role: auth.role,
          deletedAt: row.deletedAt,
        })}
        status={report.status}
      />
    </div>
  );
}
