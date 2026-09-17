import { redirect } from "next/navigation";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";

/**
 * Node/RSC gate for /caddy (and /caddy/link).
 * Edge middleware only checks signed cookie + role claim.
 * This re-checks DB User.sessionVersion, DB role, and RETIRED via resolveAuthUser.
 * AuthStoreUnavailableError는 여기서 login redirect로 바꾸지 않는다.
 */
export default async function CaddyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth) {
    redirect("/login?callbackUrl=/caddy");
  }
  if (shouldForcePasswordChange(auth)) {
    redirect("/change-password");
  }
  if (
    auth.role !== "caddy" &&
    auth.role !== "leader" &&
    auth.role !== "admin"
  ) {
    redirect("/login?callbackUrl=/caddy");
  }
  return <>{children}</>;
}
