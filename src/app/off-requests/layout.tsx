import { redirect } from "next/navigation";
import { canUseOffRequestPages } from "@/lib/offRequestAuth";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { OFF_REQUEST_ADMIN_PATH } from "@/lib/offRequestUi";

export const dynamic = "force-dynamic";

/**
 * Node/RSC gate for /off-requests.
 * Admin uses /manage/off-requests (existing /manage admin gate).
 * Caddy/leader stay on the member surface. RETIRED is denied by resolveAuthUser.
 */
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
  if (auth.role === "admin") {
    redirect(OFF_REQUEST_ADMIN_PATH);
  }
  return <>{children}</>;
}
