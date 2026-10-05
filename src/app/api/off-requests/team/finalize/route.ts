import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { finalizeTeamOffRequests } from "@/lib/offRequestPhase2Service";

export const dynamic = "force-dynamic";

/** POST — 팀장 자기 PRIMARY 조 최종확정 + Assignment(OFF). */
export async function POST(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const body = await req.json().catch(() => ({}));
    const result = await finalizeTeamOffRequests(prisma, actor, {
      month: String(body?.month ?? "").trim(),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
