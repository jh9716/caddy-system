import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { upsertOffRequestQuota } from "@/lib/offRequestWindowService";

export const dynamic = "force-dynamic";

/** PUT — admin 조×날짜 quota override */
export async function PUT(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const body = await req.json().catch(() => ({}));
    const result = await upsertOffRequestQuota(prisma, actor, {
      month: String(body?.month ?? "").trim(),
      team: String(body?.team ?? "").trim(),
      date: String(body?.date ?? "").trim(),
      limit: body?.limit,
    });
    return NextResponse.json({
      ok: true,
      month: result.window.yearMonth,
      team: result.team,
      date: result.date,
      limit: result.limit,
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
