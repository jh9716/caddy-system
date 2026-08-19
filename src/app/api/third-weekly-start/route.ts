import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  ThirdWeeklyStartError,
  clearThirdWeeklyStartOverride,
  resolveThirdWeeklyStart,
  setThirdWeeklyStartOverride,
} from "@/lib/thirdWeeklyStartService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(e: unknown) {
  if (e instanceof ThirdWeeklyStartError) {
    return NextResponse.json(
      { error: e.message, code: e.code },
      { status: e.status }
    );
  }
  const message = e instanceof Error ? e.message : "3부반 시작조 처리 실패";
  if (/date must be YYYY-MM-DD/.test(message)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }
  console.error("[third-weekly-start]", e);
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
    return NextResponse.json(await resolveThirdWeeklyStart(date));
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH { date, startTeam } — startTeam=null 이면 그 주 자동값 복원 */
export async function PATCH(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const body = await req.json().catch(() => null);
    const date = String(body?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
    }
    if (body?.startTeam == null || body?.startTeam === "") {
      return NextResponse.json(await clearThirdWeeklyStartOverride(date));
    }
    return NextResponse.json(
      await setThirdWeeklyStartOverride(date, String(body.startTeam))
    );
  } catch (e) {
    return errorResponse(e);
  }
}
