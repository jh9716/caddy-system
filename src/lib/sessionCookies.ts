import type { NextRequest, NextResponse } from "next/server";

export type AppRole = "admin" | "caddy";

const MAX_AGE = 60 * 60 * 8; // 8h

/** DB/env role 문자열 → 앱 역할 (ADMIN/STAFF 등 Production 레거시 값 수용) */
export function normalizeAppRole(input: unknown): AppRole | null {
  const raw = String(input ?? "")
    .trim()
    .toLowerCase();
  if (raw === "admin") return "admin";
  if (raw === "caddy" || raw === "staff") return "caddy";
  return null;
}

/** Cloudflare/Vercel 프록시 뒤에서도 HTTPS를 정확히 판별 */
export function isHttpsRequest(req: NextRequest | Request): boolean {
  const forwarded =
    (req as NextRequest).headers?.get?.("x-forwarded-proto") ||
    (req as Request).headers?.get?.("x-forwarded-proto") ||
    "";
  // "https, http" 같은 다중 값에서 첫 토큰만 사용
  const proto = String(forwarded).split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;

  const nextProto =
    typeof (req as NextRequest).nextUrl?.protocol === "string"
      ? (req as NextRequest).nextUrl.protocol.replace(":", "").toLowerCase()
      : "";
  if (nextProto === "https") return true;

  try {
    if (new URL(req.url).protocol === "https:") return true;
  } catch {
    // ignore
  }

  // Vercel Production/Preview edge 는 HTTPS
  if (process.env.VERCEL === "1") return true;
  return false;
}

export function getRoleFromCookies(
  cookies: { get: (name: string) => { value: string } | undefined }
): AppRole | null {
  const role =
    cookies.get("role")?.value ||
    cookies.get("session_role")?.value ||
    (cookies.get("admin")?.value === "1" ? "admin" : null);
  return normalizeAppRole(role);
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

  // middleware / manage layout / requireAdmin 이 읽는 주 쿠키
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

export function clearSessionCookies(
  res: NextResponse,
  req?: NextRequest | Request
) {
  const secure = req
    ? isHttpsRequest(req)
    : process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
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
