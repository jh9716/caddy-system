import { prisma } from "@/lib/prisma";
import Link from "next/link";
import dayjs from "dayjs";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { toCourseReportPublic, parseCourseReportStatusFilter } from "@/lib/courseReport";
import {
  COURSE_REPORT_LIST_TAKE,
  COURSE_REPORT_STATUSES,
  COURSE_REPORT_STATUS_LABELS,
} from "@/lib/courseReportConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CourseReportListPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }> | { status?: string };
}) {
  const auth = await getRequestAuthUser();
  if (!auth) return null;

  const resolved = await Promise.resolve(searchParams ?? {});
  const status = parseCourseReportStatusFilter(resolved.status);

  const rows = await prisma.courseReport.findMany({
    where: {
      deletedAt: null,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: COURSE_REPORT_LIST_TAKE,
    include: { _count: { select: { photos: true } } },
  });
  const reports = rows.map((row) => toCourseReportPublic(row, row._count.photos));

  return (
    <div className="course-report-page">
      <div className="course-report-page-head">
        <h1 className="ui-page-title">코스 제보</h1>
        <Link
          href="/course-reports/new"
          className="ui-btn ui-btn-primary course-report-compose-link"
        >
          + 제보하기
        </Link>
      </div>

      <div className="course-report-filters" role="tablist" aria-label="처리상태">
        <Link
          href="/course-reports"
          className={`course-report-chip${status == null ? " is-active" : ""}`}
        >
          전체
        </Link>
        {COURSE_REPORT_STATUSES.map((code) => (
          <Link
            key={code}
            href={`/course-reports?status=${code}`}
            className={`course-report-chip${status === code ? " is-active" : ""}`}
          >
            {COURSE_REPORT_STATUS_LABELS[code]}
          </Link>
        ))}
      </div>

      <ul className="course-report-list">
        {reports.map((row) => (
          <li key={row.id}>
            <Link className="course-report-list-row" href={`/course-reports/${row.id}`}>
              <div className="course-report-list-title-row">
                <span className={`course-report-badge is-${row.status.toLowerCase()}`}>
                  {row.statusLabel}
                </span>
                <span className="course-report-cat">{row.categoryLabel}</span>
                <span className="course-report-list-title">{row.title}</span>
              </div>
              <div className="course-report-list-meta">
                <span>
                  {row.courseLabel}
                  {row.hole != null ? ` ${row.hole}홀` : ""}
                </span>
                <span>{row.authorDisplayName}</span>
                <time>{dayjs(row.createdAt).format("YYYY-MM-DD HH:mm")}</time>
                {row.photoCount > 0 ? (
                  <span className="course-report-photo-count" aria-label={`사진 ${row.photoCount}장`}>
                    사진 {row.photoCount}
                  </span>
                ) : null}
              </div>
            </Link>
          </li>
        ))}
        {reports.length === 0 && (
          <li className="course-report-empty">등록된 제보가 없습니다.</li>
        )}
      </ul>
    </div>
  );
}
