import { redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { shouldUseManageShellForBoard } from "@/lib/boardNav";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { canUseOffRequestPages } from "@/lib/offRequestAuth";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function OffRequestsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth || !canUseOffRequestPages(auth.role)) {
    redirect("/login?callbackUrl=/off-requests");
  }
  if (shouldForcePasswordChange(auth)) {
    redirect("/change-password");
  }
  if (shouldUseManageShellForBoard(auth.role)) {
    return (
      <ManageShell canManageStaffAccounts={isAccountManagerAuth(auth)}>
        {children}
      </ManageShell>
    );
  }
  return <>{children}</>;
}
