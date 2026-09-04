import { NextRequest, NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { previousKstYmd } from "@/lib/kstDate";
import { captureDailyOpsSnapshot } from "@/lib/dailyOpsSnapshotService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/cron/daily-ops-snapshot
 * 같은 전날 날짜를 최대 3회 시도:
 *   00:30 KST = 15:30 UTC
 *   01:30 KST = 16:30 UTC
 *   02:30 KST = 17:30 UTC
 * 이미 Snapshot이 있으면 Sheet fetch 없이 exists. overwrite 없음.
 */
export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const date = previousKstYmd();
    const result = await captureDailyOpsSnapshot(date);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "snapshot capture 실패";
    console.error("[GET /api/cron/daily-ops-snapshot]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
