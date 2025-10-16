import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // role 쿠키 제거
  res.cookies.set("role", "", { path: "/", expires: new Date(0) });
  return res;
}
