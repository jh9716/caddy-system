import { notFound, redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { canReadCommunity } from "@/lib/communityBoard";
import { COMMUNITY_FREE_BOARD_LABEL, isCommunityFreeBoardEnabled } from "@/lib/communityBoardConstants";
import { isUnlinkedStaffAccount } from "@/lib/auth";
import { shouldUseManageShellForBoard } from "@/lib/boardNav";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";
export const metadata = { title: COMMUNITY_FREE_BOARD_LABEL };

/**
 * /talk (커뮤니티 자유게시판) gate.
 * Edge middleware 는 서명 쿠키·역할만 본다. 여기서 DB sessionVersion·역할·퇴사(RETIRED)를 다시 확인한다.
 * 미연결 캐디·조장은 /caddy/link 로. Admin 은 ManageShell, 캐디·조장은 기존 AppHeader.
 */
export default async function TalkLayout({ children }: { children: React.ReactNode }) {
  if (!isCommunityFreeBoardEnabled()) notFound();
  const auth = await getRequestAuthUser();
  if (!auth || !canReadCommunity(auth.role)) {
    redirect("/login?callbackUrl=/talk");
  }
  if (shouldForcePasswordChange(auth)) redirect("/change-password");
  if (isUnlinkedStaffAccount(auth)) redirect("/caddy/link");
  if (shouldUseManageShellForBoard(auth.role)) {
    return <ManageShell canManageStaffAccounts={isAccountManagerAuth(auth)}>{children}</ManageShell>;
  }
  return <>{children}</>;
}
