import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { DailyOpsDutyError } from "@/lib/dailyOpsDutyService";
import {
  overrideWriteJson,
  writeDailyOpsDutyOverride,
} from "@/lib/opsDutyEffectiveService";
import type { OpsDutyOverrideWriteAction } from "@/lib/opsDutyEffective";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function ipOf(req: NextRequest): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

function parseAction(raw: unknown): OpsDutyOverrideWriteAction | null {
  const value = String(raw || "").trim().toUpperCase();
  if (value === "SET" || value === "CLEAR" || value === "RESTORE") return value;
  return null;
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
    const action = parseAction(body.action);
    if (!action) {
      return NextResponse.json({ error: "action=SET|CLEAR|RESTORE 필요" }, { status: 400 });
    }
    const result = await writeDailyOpsDutyOverride({
      date,
      roleKey: String(body.roleKey || "").trim(),
      action,
      caddyId: body.caddyId,
      ip: ipOf(req),
      username: auth?.username || null,
      userId: auth?.userId ?? null,
    });
    return NextResponse.json(overrideWriteJson(result));
  } catch (e: unknown) {
    if (e instanceof DailyOpsDutyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "운영현황 수동 수정 실패";
    console.error("[POST /api/daily-ops-duties/override]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
