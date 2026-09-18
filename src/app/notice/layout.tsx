import { redirect } from "next/navigation";
import { canReadInternalNotice } from "@/lib/noticeAccess";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";

/**
 * Node/RSC gate for /notice.
 * Edge middleware only checks signed cookie + role claim.
 * This re-checks DB User.sessionVersion, DB role, and RETIRED via resolveAuthUser.
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
  return <>{children}</>;
}
