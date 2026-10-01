import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { getOffRequestCalendar } from "@/lib/offRequestWindowService";

export const dynamic = "force-dynamic";

/** GET — 캐디 월간 캘린더. 다른 신청자 이름 없음. */
export async function GET(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const month = req.nextUrl.searchParams.get("month")?.trim() || "";
    const calendar = await getOffRequestCalendar(prisma, actor, month);
    return NextResponse.json({ ok: true, ...calendar });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
