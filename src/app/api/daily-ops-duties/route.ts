import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { DailyOpsDutyError, listDailyOpsDuties } from "@/lib/dailyOpsDutyService";
import { countByOpsRole } from "@/lib/dailyOpsDuty";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const date = String(req.nextUrl.searchParams.get("date") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    const rows = await listDailyOpsDuties(date);
    return NextResponse.json({
      date,
      count: rows.length,
      byRole: countByOpsRole(rows),
      caddyIds: [...new Set(rows.map((r) => r.caddyId))],
      rows,
    });
  } catch (e: unknown) {
    if (e instanceof DailyOpsDutyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "당번 일정 조회 실패";
    console.error("[GET /api/daily-ops-duties]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
