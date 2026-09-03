import { NextRequest, NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { previousKstYmd } from "@/lib/kstDate";
import { captureDailyOpsSnapshot } from "@/lib/dailyOpsSnapshotService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/cron/daily-ops-snapshot
 * 00:30 KST (= 15:30 UTC) — 전날 운영현황을 1회 보존.
 * 같은 날짜가 이미 있으면 overwrite 없이 exists.
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
