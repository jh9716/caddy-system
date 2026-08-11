import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { rejectOffRequest, serializeOffRequest } from "@/lib/offRequestService";

export const dynamic = "force-dynamic";

/** POST — 조장/관리자 반려 (Assignment 미생성) */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const params = await Promise.resolve(ctx.params);
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { error: "invalid_id", message: "id 필요" },
        { status: 400 }
      );
    }
    const body = await req.json().catch(() => ({}));
    const updated = await rejectOffRequest(prisma, actor, id, {
      decisionNote: body?.decisionNote ?? null,
    });
    return NextResponse.json({
      ok: true,
      offRequest: serializeOffRequest(updated),
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
