import { notFound, redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { canReadFreeBoard } from "@/lib/freeBoard";
import { isFreeBoardEnabled } from "@/lib/freeBoardConstants";
import { shouldUseManageShellForBoard } from "@/lib/boardNav";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";

/**
 * /community (자유게시판 V1) gate.
 * Feature flag OFF → 404 (Production 기본값). 로그인 caddy/leader/admin 만.
 * Admin 은 ManageShell, caddy/leader 는 root AppHeader (공지·제보와 동일 패턴).
 */
export default async function CommunityLayout({ children }: { children: React.ReactNode }) {
  if (!isFreeBoardEnabled()) notFound();
  const auth = await getRequestAuthUser();
  if (!auth || !canReadFreeBoard(auth.role)) {
    redirect("/login?callbackUrl=/community");
  }
  if (shouldForcePasswordChange(auth)) redirect("/change-password");
  if (shouldUseManageShellForBoard(auth.role)) {
    return (
      <ManageShell canManageStaffAccounts={isAccountManagerAuth(auth)}>{children}</ManageShell>
    );
  }
  return <>{children}</>;
}
