import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { listUnavailablePanelRows } from "@/lib/dailyBoardDraftService";
import {
  DailyUnavailableWriteError,
  writeDailyUnavailable,
} from "@/lib/dailyUnavailableWrite";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function ipOf(req: NextRequest): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const date = String(req.nextUrl.searchParams.get("date") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    const rows = await listUnavailablePanelRows(date);
    return NextResponse.json({ date, count: rows.length, rows });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "병가/결근 조회 실패";
    console.error("[GET /api/daily-unavailables]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const auth = await resolveAuthUser(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON 필요" }, { status: 400 });
    }
    const date = String(body.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    const action = String(body.action || "").trim().toUpperCase();
    if (action !== "SET" && action !== "CLEAR") {
      return NextResponse.json({ error: "action=SET|CLEAR 필요" }, { status: 400 });
    }
    const result = await writeDailyUnavailable({
      date,
      action,
      caddyId: body.caddyId,
      reason: body.reason,
      ip: ipOf(req),
      username: auth?.username || null,
      userId: auth?.userId ?? null,
    });
    return NextResponse.json({
      ok: true,
      action: result.action,
      date: result.date,
      caddyId: result.caddyId,
      reason: result.reason,
      rows: result.rows,
    });
  } catch (e: unknown) {
    if (e instanceof DailyUnavailableWriteError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "병가/결근 저장 실패";
    console.error("[POST /api/daily-unavailables]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
