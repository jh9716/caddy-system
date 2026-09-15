import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { isDailyOffOverrideWriteAction } from "@/lib/offEffective";
import {
  DailyOffOverrideError,
  listDailyOffOverrides,
  offOverrideWriteJson,
  writeDailyOffOverride,
} from "@/lib/offEffectiveService";

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
    const overrides = await listDailyOffOverrides(date);
    return NextResponse.json({
      date,
      count: overrides.length,
      overrides: overrides.map((row) => ({
        caddyId: row.caddyId,
        action: row.action,
        name: row.name,
        team: row.team,
      })),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "휴무 overlay 조회 실패";
    console.error("[GET /api/daily-off-overrides]", e);
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
    if (!isDailyOffOverrideWriteAction(action)) {
      return NextResponse.json(
        { error: "action=FORCE_OFF|FORCE_AVAILABLE|RESTORE 필요" },
        { status: 400 }
      );
    }
    const result = await writeDailyOffOverride({
      date,
      action,
      caddyId: body.caddyId,
      ip: ipOf(req),
      username: auth?.username || null,
      userId: auth?.userId ?? null,
    });
    return NextResponse.json(offOverrideWriteJson(result));
  } catch (e: unknown) {
    if (e instanceof DailyOffOverrideError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "휴무 수동 수정 실패";
    console.error("[POST /api/daily-off-overrides]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
