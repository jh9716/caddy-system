import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  isOffSheetUnresolvedError,
  prewarmCanonicalOffSheet,
} from "@/lib/caddyPoolCanonicalService";
import { offCaddyIdsFromNames } from "@/lib/offSnapshot";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/assignments/off-sheet/prewarm?date=YYYY-MM-DD
 * Background date-matched OFF SoT warm. UI must not wait.
 * On match, returns caddyIds so the client can store Draft.offSnapshot.
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
    let caddyIds: number[] = [];
    if (resolved.matched) {
      const caddies = await prisma.caddy.findMany({
        select: { id: true, name: true, employmentStatus: true },
      });
      caddyIds = offCaddyIdsFromNames(resolved.names, caddies);
    }
    return NextResponse.json({
      ok: true,
      date,
      matched: resolved.matched,
      source: resolved.source,
      resolveMs: resolved.resolveMs,
      names: resolved.names,
      caddyIds,
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
