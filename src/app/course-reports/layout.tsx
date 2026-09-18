import { redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { canReadCourseReport } from "@/lib/courseReportAccess";
import { shouldUseManageShellForCourseReport } from "@/lib/boardNav";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";

/**
 * Node/RSC gate for /course-reports.
 * Edge middleware only checks signed cookie + role claim.
 * This re-checks DB User.sessionVersion, DB role, and RETIRED via resolveAuthUser.
 * Admin reuses ManageShell. Caddy/leader keep AppHeader from root layout.
 */
export default async function CourseReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth || !canReadCourseReport(auth.role)) {
    redirect("/login?callbackUrl=/course-reports");
  }
  if (shouldForcePasswordChange(auth)) {
    redirect("/change-password");
  }
  if (shouldUseManageShellForCourseReport(auth.role)) {
    return (
      <ManageShell canManageStaffAccounts={isAccountManagerAuth(auth)}>
        {children}
      </ManageShell>
    );
  }
  return <>{children}</>;
}
