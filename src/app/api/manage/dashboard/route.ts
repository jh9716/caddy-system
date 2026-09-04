import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { loadAdminOpsDashboardView } from "@/lib/dailyOpsSnapshotService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/manage/dashboard?date=YYYY-MM-DD
 * 오늘/미래: live. 과거+snapshot: 저장된 payload. write 없음.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const date = req.nextUrl.searchParams.get("date")?.trim() || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    const payload = await loadAdminOpsDashboardView(date);
    return NextResponse.json({ ok: true, ...payload });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "대시보드 조회 실패";
    console.error("[GET /api/manage/dashboard]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
