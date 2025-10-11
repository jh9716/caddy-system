// app/api/me/route.ts
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic"; // 캐시/프리렌더 방지

export async function GET() {
  return NextResponse.json({ ok: true, source: "/api/me" });
}
