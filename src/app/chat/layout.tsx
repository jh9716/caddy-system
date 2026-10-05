import { redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { shouldUseManageShellForBoard } from "@/lib/boardNav";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth) {
    redirect("/login?callbackUrl=/chat");
  }
  if (shouldForcePasswordChange(auth)) {
    redirect("/change-password");
  }
  if (auth.role !== "caddy" && auth.role !== "leader" && auth.role !== "admin") {
    redirect("/login?callbackUrl=/chat");
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
