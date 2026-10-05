import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { finalizeTeamOffRequestsAsAdmin } from "@/lib/offRequestPhase2Service";

export const dynamic = "force-dynamic";

/** POST — 관리자가 특정 PRIMARY 조를 대행 확정. 같은 finalize transaction. */
export async function POST(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const body = await req.json().catch(() => ({}));
    const result = await finalizeTeamOffRequestsAsAdmin(prisma, actor, {
      month: String(body?.month ?? "").trim(),
      team: String(body?.team ?? "").trim(),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
