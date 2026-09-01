import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  isOffSheetUnresolvedError,
  prewarmCanonicalOffSheet,
} from "@/lib/caddyPoolCanonicalService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/assignments/off-sheet/prewarm?date=YYYY-MM-DD
 * Background date-matched OFF SoT warm. UI must not wait.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const date = req.nextUrl.searchParams.get("date")?.trim() || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }

  try {
    const resolved = await prewarmCanonicalOffSheet(date);
    return NextResponse.json({
      ok: true,
      date,
      matched: resolved.matched,
      source: resolved.source,
      resolveMs: resolved.resolveMs,
    });
  } catch (e: unknown) {
    if (isOffSheetUnresolvedError(e)) {
      return NextResponse.json(
        { error: e.message, code: e.code, message: e.message },
        { status: e.status }
      );
    }
    return NextResponse.json({ error: "휴무 미리 불러오기 실패" }, { status: 500 });
  }
}
