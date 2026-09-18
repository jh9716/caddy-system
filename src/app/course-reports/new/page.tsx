import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { redirect } from "next/navigation";
import CourseReportForm from "../CourseReportForm";
import { canWriteCourseReport } from "@/lib/courseReportAccess";

export const dynamic = "force-dynamic";

export default async function NewCourseReportPage() {
  const auth = await getRequestAuthUser();
  if (!auth || !canWriteCourseReport(auth.role)) {
    redirect("/login?callbackUrl=/course-reports/new");
  }
  if (auth.mustChangePassword) redirect("/change-password");
  // Env-only admin (userId=null) must still reach the compose form.
  // POST remains 403 without a DB User.id — do not bounce the list CTA.

  return (
    <div className="course-report-page">
      <h1 className="ui-page-title">제보하기</h1>
      <CourseReportForm />
    </div>
  );
}
