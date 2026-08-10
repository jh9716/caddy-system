import type { NextRequest, NextResponse } from "next/server";

export type AppRole = "admin" | "caddy";

const MAX_AGE = 60 * 60 * 8; // 8h

/** Cloudflare 터널 등 프록시 뒤에서도 HTTPS를 정확히 판별 */
export function isHttpsRequest(req: NextRequest | Request): boolean {
  const proto =
    (req as NextRequest).headers?.get?.("x-forwarded-proto") ||
    (typeof (req as NextRequest).nextUrl?.protocol === "string"
      ? (req as NextRequest).nextUrl.protocol.replace(":", "")
      : null);
  if (proto === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function getRoleFromCookies(
  cookies: { get: (name: string) => { value: string } | undefined }
): AppRole | null {
  const role =
    cookies.get("role")?.value ||
    cookies.get("session_role")?.value ||
    (cookies.get("admin")?.value === "1" ? "admin" : null);
  if (role === "admin" || role === "caddy") return role;
  return null;
}

export function applySessionCookies(
  res: NextResponse,
  req: NextRequest | Request,
  role: AppRole,
  username: string
) {
  const secure = isHttpsRequest(req);
  const base = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: MAX_AGE,
  };

  // UI / manage 페이지가 읽는 주 쿠키
  res.cookies.set("role", role, base);
  // 하위 호환 (구 API·가드)
  res.cookies.set("session_role", role, base);
  res.cookies.set("session_user", username, base);
  if (role === "admin") {
    res.cookies.set("admin", "1", base);
  } else {
    res.cookies.set("admin", "", { ...base, maxAge: 0 });
  }
}

export function clearSessionCookies(res: NextResponse, req?: NextRequest | Request) {
  const secure = req ? isHttpsRequest(req) : false;
  const base = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: 0,
  };
  for (const name of ["role", "session_role", "session_user", "admin"]) {
    res.cookies.set(name, "", base);
  }
}
