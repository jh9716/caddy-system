import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { isCourseReportCourse } from "@/lib/courseReport";
import { canEditCourseReportContent } from "@/lib/courseReportAccess";
import CourseReportForm from "../../CourseReportForm";
import { findCourseReportWithPhotos } from "@/lib/courseReportPhoto";
import {
  COURSE_REPORT_CATEGORIES,
  type CourseReportCategoryCode,
} from "@/lib/courseReportConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function EditCourseReportPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/course-reports");
  if (auth.mustChangePassword) redirect("/change-password");

  const resolved = await Promise.resolve(params);
  const id = Number(resolved.id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const loaded = await findCourseReportWithPhotos(prisma, id);
  if (!loaded) notFound();
  const row = loaded.report;

  if (
    !canEditCourseReportContent({
      role: auth.role,
      userId: auth.userId,
      authorUserId: row.authorUserId,
      status: row.status,
      deletedAt: row.deletedAt,
    })
  ) {
    redirect(`/course-reports/${id}`);
  }

  const course = isCourseReportCourse(row.course) ? row.course : "VERTHILL";
  const category = (COURSE_REPORT_CATEGORIES as readonly string[]).includes(row.category)
    ? (row.category as CourseReportCategoryCode)
    : "OTHER";

  return (
    <div className="course-report-page">
      <h1 className="ui-page-title">제보 수정</h1>
      <CourseReportForm
        mode="edit"
        canManagePhotos
        initial={{
          id,
          title: row.title,
          body: row.body,
          course,
          hole: row.hole,
          category,
          photos: loaded.photos,
        }}
      />
    </div>
  );
}
