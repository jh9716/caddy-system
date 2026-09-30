/**
 * Member-page client helper: one /login redirect on 401.
 * Used by board / notice / course-report / caddy clients.
 *
 * Exempt: /login, Kakao OAuth, logout UX, public legal pages,
 * and admin surfaces that already handle 401 themselves.
 * 403 MUST_CHANGE_PASSWORD and 503 auth_unavailable are not session expiry.
 */

import { safeReturnPath } from "@/lib/safeReturnPath";

export type MemberSessionLocation = {
  pathname: string;
  search?: string;
  replace: (href: string) => void;
};

let redirectScheduled = false;

export function resetMemberSessionRedirectForTests(): void {
  redirectScheduled = false;
}

export function isExemptMemberSessionRedirectPath(pathname: string): boolean {
  const p = String(pathname ?? "").split("?")[0] || "/";
  if (p === "/login" || p.startsWith("/login/")) return true;
  if (p.startsWith("/api/auth/kakao")) return true;
  if (p === "/privacy" || p.startsWith("/privacy/")) return true;
  if (p === "/account-deletion" || p.startsWith("/account-deletion/")) return true;
  if (p.startsWith("/manage")) return true;
  if (p === "/assignments" || p.startsWith("/assignments/")) return true;
  if (p === "/schedule" || p.startsWith("/schedule/")) return true;
  return false;
}

function currentLocation(): MemberSessionLocation | null {
  if (typeof window === "undefined") return null;
  return {
    pathname: window.location.pathname || "/",
    search: window.location.search || "",
    replace: (href: string) => {
      window.location.replace(href);
    },
  };
}

export function redirectMemberToLogin(
  loc: MemberSessionLocation | null = currentLocation()
): boolean {
  if (!loc) return false;
  if (isExemptMemberSessionRedirectPath(loc.pathname)) return false;
  if (redirectScheduled) return true;
  redirectScheduled = true;
  const raw = `${loc.pathname}${loc.search ?? ""}`;
  const cb = safeReturnPath(raw) || "/caddy";
  loc.replace(`/login?callbackUrl=${encodeURIComponent(cb)}`);
  return true;
}

/** True when this 401 was consumed as a login redirect (or already scheduled). */
export function consumeUnauthorizedMemberResponse(
  res: { status: number },
  loc?: MemberSessionLocation | null
): boolean {
  if (res.status !== 401) return false;
  return redirectMemberToLogin(loc === undefined ? currentLocation() : loc);
}
