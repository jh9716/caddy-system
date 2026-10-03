import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import {
  rescheduleTeamOffRequest,
  serializeTeamOffRequest,
} from "@/lib/offRequestPhase2Service";

export const dynamic = "force-dynamic";

/** POST — 팀장 자기 팀 REQUESTED 날짜 변경 + Adjustment history. */
export async function POST(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const body = await req.json().catch(() => ({}));
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { error: "invalid_id", message: "id 필요" },
        { status: 400 }
      );
    }
    const result = await rescheduleTeamOffRequest(prisma, actor, {
      id,
      toDate: body?.toDate ?? "",
      reason: body?.reason ?? null,
    });
    return NextResponse.json({
      ok: true,
      offRequest: serializeTeamOffRequest(result.offRequest),
      adjustmentId: result.adjustmentId,
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
