import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  DailySpecialDutyError,
  buildDailySpecialDutyPayload,
  deleteDailySpecialDuty,
} from "@/lib/dailySpecialDutyService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const params = await Promise.resolve(ctx.params);
    const id = Number(params.id);
    if (!Number.isInteger(id) || id < 1) {
      return NextResponse.json({ error: "id가 필요합니다." }, { status: 400 });
    }
    const deleted = await deleteDailySpecialDuty(id);
    return NextResponse.json(await buildDailySpecialDutyPayload(deleted.date));
  } catch (e) {
    if (e instanceof DailySpecialDutyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "삭제 실패";
    console.error("[DELETE /api/daily-special-duties/:id]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
