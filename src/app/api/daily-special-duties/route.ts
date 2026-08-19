import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isDailySpecialKind, type DailySpecialKind } from "@/lib/dailySpecialDuty";
import {
  DailySpecialDutyError,
  addDailySpecialDuties,
  buildDailySpecialDutyPayload,
  moveDailySpecialDuty,
  reorderDailySpecialDuties,
} from "@/lib/dailySpecialDutyService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(e: unknown) {
  if (e instanceof DailySpecialDutyError) {
    return NextResponse.json(
      { error: e.message, code: e.code },
      { status: e.status }
    );
  }
  const message = e instanceof Error ? e.message : "특수근무 처리 실패";
  if (/date must be YYYY-MM-DD/.test(message)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }
  console.error("[daily-special-duties]", e);
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const date = String(req.nextUrl.searchParams.get("date") || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    return NextResponse.json(await buildDailySpecialDutyPayload(date));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const body = await req.json().catch(() => null);
    const date = String(body?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    if (!isDailySpecialKind(body?.kind)) {
      return NextResponse.json({ error: "유형을 선택하세요." }, { status: 400 });
    }
    const caddies = await prisma.caddy.findMany({
      select: { id: true, name: true, employmentStatus: true },
    });
    const result = await addDailySpecialDuties({
      date,
      kind: body.kind as DailySpecialKind,
      caddyIds: Array.isArray(body?.caddyIds) ? body.caddyIds : [],
      namesText: typeof body?.namesText === "string" ? body.namesText : "",
      caddies,
    });
    const payload = await buildDailySpecialDutyPayload(date);
    return NextResponse.json({
      ...payload,
      added: result.added,
      reviews: result.reviews,
      duplicates: result.duplicates,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const body = await req.json().catch(() => null);
    if (body?.action === "move") {
      const id = Number(body?.id);
      const direction = body?.direction;
      if (!Number.isInteger(id) || id < 1) {
        return NextResponse.json({ error: "id가 필요합니다." }, { status: 400 });
      }
      if (direction !== "up" && direction !== "down") {
        return NextResponse.json({ error: "direction=up|down" }, { status: 400 });
      }
      const moved = await moveDailySpecialDuty(id, direction);
      return NextResponse.json(await buildDailySpecialDutyPayload(moved.date));
    }

    const date = String(body?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    if (!isDailySpecialKind(body?.kind)) {
      return NextResponse.json({ error: "유형을 선택하세요." }, { status: 400 });
    }
    if (!Array.isArray(body?.orderedCaddyIds)) {
      return NextResponse.json(
        { error: "orderedCaddyIds가 필요합니다." },
        { status: 400 }
      );
    }
    await reorderDailySpecialDuties({
      date,
      kind: body.kind,
      orderedCaddyIds: body.orderedCaddyIds.map(Number),
    });
    return NextResponse.json(await buildDailySpecialDutyPayload(date));
  } catch (e) {
    return errorResponse(e);
  }
}
