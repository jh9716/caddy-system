import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadDashboardAccountLinkSummary } from "@/lib/adminCaddyLinkSummaryService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/manage/account-link-summary
 * ACTIVE 캐디 계정 연결 요약 1회. 대시보드 운영 조회와 분리.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const summary = await loadDashboardAccountLinkSummary(prisma);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "계정 연결 요약 조회 실패";
    console.error("[GET /api/manage/account-link-summary]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
