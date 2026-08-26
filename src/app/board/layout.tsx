import { redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { canReadPublishedBoard } from "@/lib/auth";
import { shouldUseManageShellForBoard } from "@/lib/boardNav";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";

export default async function BoardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth || !canReadPublishedBoard(auth.role)) {
    redirect("/login?callbackUrl=/board");
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
