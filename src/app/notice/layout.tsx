import { redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { canReadInternalNotice } from "@/lib/noticeAccess";
import { shouldUseManageShellForNotice } from "@/lib/boardNav";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";

/**
 * Node/RSC gate for /notice.
 * Edge middleware only checks signed cookie + role claim.
 * This re-checks DB User.sessionVersion, DB role, and RETIRED via resolveAuthUser.
 * Admin reuses ManageShell (hamburger / VERTHILL / bottom tabs).
 * Caddy/leader keep the shared AppHeader from root layout — no admin menus.
 */
export default async function NoticeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth || !canReadInternalNotice(auth.role)) {
    redirect("/login?callbackUrl=/notice");
  }
  if (shouldForcePasswordChange(auth)) {
    redirect("/change-password");
  }
  if (shouldUseManageShellForNotice(auth.role)) {
    return (
      <ManageShell canManageStaffAccounts={isAccountManagerAuth(auth)}>
        {children}
      </ManageShell>
    );
  }
  return <>{children}</>;
}
