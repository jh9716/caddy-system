import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DailyOpsDutyError } from "@/lib/dailyOpsDutyService";
import { countByOpsRole } from "@/lib/dailyOpsDuty";
import { buildOpsDutySlotStates } from "@/lib/opsDutyEffective";
import { listDailyOpsDutyOverrides } from "@/lib/opsDutyEffectiveService";
import {
  opsDutyPanelRowsFromReadOnly,
  resolveOpsDutyReadOnly,
} from "@/lib/opsDutyReadOnlySource";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const date = String(req.nextUrl.searchParams.get("date") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    const resolved = await resolveOpsDutyReadOnly(date);
    const caddies = await prisma.caddy.findMany({
      select: { id: true, name: true, team: true, employmentStatus: true },
    });
    const rows = opsDutyPanelRowsFromReadOnly(resolved, caddies);
    const payload: Record<string, unknown> = {
      date,
      source: resolved.source,
      persisted: resolved.source === "stored",
      count: rows.length,
      byRole: countByOpsRole(rows),
      caddyIds: [...new Set(rows.map((r) => r.caddyId))],
      rows,
      error: resolved.error,
    };
    try {
      const overrides = await listDailyOpsDutyOverrides(date);
      payload.slots = buildOpsDutySlotStates(rows, overrides);
    } catch (overlayError) {
      console.error("[GET /api/daily-ops-duties] overlay slots skipped", overlayError);
    }
    return NextResponse.json(payload);
  } catch (e: unknown) {
    if (e instanceof DailyOpsDutyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "당번 일정 조회 실패";
    console.error("[GET /api/daily-ops-duties]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
