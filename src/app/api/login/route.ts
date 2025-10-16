import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { username, password } = await req.json().catch(() => ({}));

  const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
  const CADDY_USER = process.env.CADDY_USER ?? "caddy";
  const CADDY_PASSWORD = process.env.CADDY_PASSWORD ?? "";

  let role: "admin" | "caddy" | null = null;

  if (username === ADMIN_USER && password === ADMIN_PASSWORD) role = "admin";
  if (username === CADDY_USER && password === CADDY_PASSWORD) role = "caddy";

  if (!role) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, role });

  // role 쿠키 설정 (서버 렌더에서만 읽으므로 httpOnly 여도 무방)
  res.cookies.set("role", role, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // 필요하면 expires 나 maxAge로 지속시간도 설정
  });

  return res;
}
