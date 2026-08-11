import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { summarizeOffRequests } from "@/lib/offRequestService";

export const dynamic = "force-dynamic";

/** GET — 조별 승인 n/5 · 신청(대기) 집계 (?date=&team=) */
export async function GET(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const date = req.nextUrl.searchParams.get("date")?.trim() || "";
    const team = req.nextUrl.searchParams.get("team");
    if (!date) {
      return NextResponse.json(
        { error: "invalid_date", message: "date=YYYY-MM-DD 필요" },
        { status: 400 }
      );
    }
    const teams = await summarizeOffRequests(prisma, actor, { date, team });
    return NextResponse.json({ ok: true, date, teams });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
