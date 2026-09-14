import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import {
  DailySpecialSupportError,
  buildDailySpecialSupportPayload,
  deleteDailySpecialSupport,
  moveDailySpecialSupport,
  replaceDailySpecialSupportGroup,
  replaceDailySpecialSupports,
} from "@/lib/dailySpecialSupportService";
import {
  isDailySpecialSupportKind,
  isDailySpecialSupportWorkPattern,
  isSpecialSupportShift,
} from "@/lib/dailySpecialSupport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(e: unknown) {
  if (e instanceof DailySpecialSupportError) {
    return NextResponse.json(
      { error: e.message, code: e.code },
      { status: e.status }
    );
  }
  const message = e instanceof Error ? e.message : "특수지원 처리 실패";
  if (/date must be YYYY-MM-DD/.test(message)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }
  console.error("[daily-special-supports]", e);
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
    const includeCandidates =
      req.nextUrl.searchParams.get("includeCandidates") === "1" ||
      req.nextUrl.searchParams.get("includeCandidates") === "true";
    return NextResponse.json(
      await buildDailySpecialSupportPayload(date, { includeCandidates })
    );
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * PUT { date, shift, caddyIds } — 레거시: 해당 부 SPECIAL_SUPPORT만 교체.
 * PUT { date, kind, workPattern, caddyIds } — date+kind+workPattern 그룹 교체.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const auth = await resolveAuthUser(req);
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }
    const date = String((body as { date?: unknown }).date || "");
    const caddyIds = (body as { caddyIds?: unknown }).caddyIds;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    if (!Array.isArray(caddyIds)) {
      return NextResponse.json({ error: "caddyIds[] 필요" }, { status: 400 });
    }
    const kindRaw = (body as { kind?: unknown }).kind;
    const patternRaw = (body as { workPattern?: unknown }).workPattern;
    const shift = String((body as { shift?: unknown }).shift || "");
    const createdByUserId = auth?.userId ?? null;

    if (isDailySpecialSupportKind(kindRaw) && isDailySpecialSupportWorkPattern(patternRaw)) {
      const result = await replaceDailySpecialSupportGroup({
        date,
        kind: kindRaw,
        workPattern: patternRaw,
        caddyIds,
        createdByUserId,
      });
      const payload = await buildDailySpecialSupportPayload(date);
      return NextResponse.json({
        ok: true,
        ...payload,
        savedKind: kindRaw,
        savedWorkPattern: patternRaw,
        added: result.added,
        removed: result.removed,
      });
    }

    if (!isSpecialSupportShift(shift)) {
      return NextResponse.json({ error: "shift는 1부/2부/3부 이어야 합니다." }, { status: 400 });
    }
    const result = await replaceDailySpecialSupports({
      date,
      shift,
      caddyIds,
      createdByUserId,
    });
    const payload = await buildDailySpecialSupportPayload(date);
    return NextResponse.json({
      ok: true,
      ...payload,
      savedShift: shift,
      added: result.added,
      removed: result.removed,
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
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }
    const action = String((body as { action?: unknown }).action || "");
    const id = Number((body as { id?: unknown }).id);
    if (!Number.isInteger(id) || id < 1) {
      return NextResponse.json({ error: "id가 필요합니다." }, { status: 400 });
    }
    if (action === "move") {
      const direction = (body as { direction?: unknown }).direction;
      if (direction !== "up" && direction !== "down") {
        return NextResponse.json({ error: "direction=up|down" }, { status: 400 });
      }
      const moved = await moveDailySpecialSupport(id, direction);
      return NextResponse.json(await buildDailySpecialSupportPayload(moved.date));
    }
    if (action === "delete") {
      const deleted = await deleteDailySpecialSupport(id);
      return NextResponse.json(await buildDailySpecialSupportPayload(deleted.date));
    }
    return NextResponse.json({ error: "action=move|delete" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
