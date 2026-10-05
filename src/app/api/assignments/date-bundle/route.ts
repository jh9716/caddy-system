import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  DailyBoardDraftPayloadError,
  resolveDraftRequestDate,
} from "@/lib/dailyBoardDraft";
import { loadAssignmentsDateBundle } from "@/lib/assignmentsDateBundle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/assignments/date-bundle?date=YYYY-MM-DD
 * /manage/assignments 날짜 load 전용 aggregate. 기존 endpoint는 유지.
 * 기존 /api/* 를 HTTP fetch로 합치지 않는다.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const date = resolveDraftRequestDate(req.nextUrl.searchParams.get("date"));
  if (!date) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }

  try {
    const bundle = await loadAssignmentsDateBundle(date);
    return NextResponse.json(bundle);
  } catch (e: unknown) {
    if (e instanceof DailyBoardDraftPayloadError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: 400 }
      );
    }
    console.error("[GET /api/assignments/date-bundle]", e);
    return NextResponse.json({ error: "날짜 묶음 조회 실패" }, { status: 500 });
  }
}
