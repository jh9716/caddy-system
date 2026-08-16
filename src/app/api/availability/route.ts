import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { loadAvailabilityForDate } from "@/lib/availabilityService";

export const dynamic = "force-dynamic";

/**
 * GET /api/availability?date=YYYY-MM-DD
 * 가용 캐디 계산 (읽기 전용). Production 데이터 수정 없음.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const date = req.nextUrl.searchParams.get("date")?.trim() || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "date=YYYY-MM-DD 필요" },
        { status: 400 }
      );
    }

    const result = await loadAvailabilityForDate(date);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[GET /api/availability]", e);
    return NextResponse.json(
      { error: e?.message || "가용 계산 실패" },
      { status: 500 }
    );
  }
}
