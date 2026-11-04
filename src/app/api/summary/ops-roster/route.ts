import { NextRequest, NextResponse } from "next/server";
import { isNoticeAuthResponse, requireNoticeReader } from "@/lib/noticeAccess";
import { loadAdminOpsDashboardView, todayKstYmd } from "@/lib/dailyOpsSnapshotService";
import { toCaddyOpsRoster } from "@/lib/caddyOpsRoster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/summary/ops-roster[?refresh=1]
 * caddy / leader / admin 로그인 필요 (비로그인 401). 오늘(KST) 고정, date 파라미터 없음.
 * 관리자 대시보드와 같은 loadAdminOpsDashboardView를 사용하고 이름·인원만 반환.
 * GET만 export → 다른 메서드는 405. write 없음.
 */
export async function GET(req: NextRequest) {
  const auth = await requireNoticeReader(req);
  if (isNoticeAuthResponse(auth)) return auth;
  try {
    const date = todayKstYmd();
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    const view = await loadAdminOpsDashboardView(date, { waitForSheet: refresh });
    return NextResponse.json(toCaddyOpsRoster(view), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    console.error("[GET /api/summary/ops-roster]", e instanceof Error ? e.message : "error");
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
}
