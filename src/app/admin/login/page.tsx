import { redirect } from "next/navigation";

/**
 * Legacy leftover: password-only form posted to a missing auth route.
 * Production admin login is /login → /api/login (C6/C7).
 * Do not add a second auth surface.
 */
export const dynamic = "force-dynamic";

export default function AdminLoginPage() {
  redirect("/login");
}
