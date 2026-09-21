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
