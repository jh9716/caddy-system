import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { getOffRequestLeaderTeamMonth } from "@/lib/offRequestPhase2Service";

export const dynamic = "force-dynamic";

/** GET — 팀장 자기 PRIMARY 조 월간 조정 현황. client team 무시. */
export async function GET(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const month = req.nextUrl.searchParams.get("month")?.trim() || "";
    const data = await getOffRequestLeaderTeamMonth(prisma, actor, month);
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
