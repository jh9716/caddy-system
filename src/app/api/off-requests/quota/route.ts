import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import {
  deleteOffRequestQuota,
  upsertOffRequestQuota,
} from "@/lib/offRequestWindowService";

export const dynamic = "force-dynamic";

function quotaInput(body: Record<string, unknown>) {
  return {
    month: String(body?.month ?? "").trim(),
    team: String(body?.team ?? "").trim(),
    date: String(body?.date ?? "").trim(),
  };
}

/** PUT — admin 조×날짜 quota override */
export async function PUT(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const body = await req.json().catch(() => ({}));
    const result = await upsertOffRequestQuota(prisma, actor, {
      ...quotaInput(body),
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

/** DELETE — override 삭제 후 defaultQuota 복귀 */
export async function DELETE(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const body = await req.json().catch(() => ({}));
    const result = await deleteOffRequestQuota(prisma, actor, quotaInput(body));
    return NextResponse.json({
      ok: true,
      month: result.window.yearMonth,
      team: result.team,
      date: result.date,
      deleted: result.deleted,
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
