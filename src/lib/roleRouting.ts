import { postLoginPath } from "@/lib/passwordPolicy";
import { safeReturnPath } from "@/lib/safeReturnPath";

export const CADDY_ONLY_ALERT = "캐디만 접근 가능합니다.";

export function isCaddyShellPath(path: string): boolean {
  const pathname = String(path ?? "").split(/[?#]/)[0];
  return pathname === "/caddy" || pathname.startsWith("/caddy/");
}

export type CaddyPageGate =
  | { action: "enter" }
  | { action: "replace"; href: "/manage"; alert: false }
  | {
      action: "deny";
      href: "/login";
      alert: true;
      alertMessage: typeof CADDY_ONLY_ALERT;
    };

/** Client gate for /caddy. Admin is not a caddy; send them to /manage without alert. */
export function resolveCaddyPageGate(role: unknown): CaddyPageGate {
  if (role === "caddy" || role === "leader") return { action: "enter" };
  if (role === "admin") {
    return { action: "replace", href: "/manage", alert: false };
  }
  return {
    action: "deny",
    href: "/login",
    alert: true,
    alertMessage: CADDY_ONLY_ALERT,
  };
}

export type CaddyLinkPageGate =
  | { action: "enter" }
  | { action: "replace"; href: "/manage" }
  | { action: "error" };

/**
 * Client gate for /caddy/link (본인확인).
 * /caddy 게이트와 같은 회원 역할(caddy·leader)을 허용한다. API(requireLinkableSubmitter)도 admin만 거부.
 * 기타 역할은 /login으로 보내지 않고 오류 상태를 보여 준다 (/login → /caddy → /caddy/link 루프 방지).
 */
export function resolveCaddyLinkPageGate(role: unknown): CaddyLinkPageGate {
  if (role === "caddy" || role === "leader") return { action: "enter" };
  if (role === "admin") return { action: "replace", href: "/manage" };
  return { action: "error" };
}

/** /login 서버 페이지의 세션 보유자 리다이렉트 (page.tsx와 동일 규칙). */
export function resolveLoginPageRedirect(
  auth: { role?: unknown } | null | undefined
): "/manage" | "/caddy" | null {
  if (auth?.role === "admin") return "/manage";
  if (auth?.role === "caddy" || auth?.role === "leader") return "/caddy";
  return null;
}

/**
 * Post-login destination.
 * Safe callback wins for caddy/leader.
 * Admin ignores /caddy* callbacks in favor of /manage.
 */
export function resolvePostLoginHref(input: {
  role: unknown;
  mustChangePassword?: boolean;
  callbackUrl?: unknown;
}): string {
  const role = String(input.role ?? "");
  if (input.mustChangePassword) return "/change-password";
  const safe = safeReturnPath(input.callbackUrl);
  if (role === "admin") {
    if (!safe || isCaddyShellPath(safe)) {
      return postLoginPath("admin", false);
    }
    return safe;
  }
  return safe || postLoginPath(role, false);
}
