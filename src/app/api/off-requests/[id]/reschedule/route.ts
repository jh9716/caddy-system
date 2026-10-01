import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { serializeOffRequest } from "@/lib/offRequestService";
import { rescheduleOwnOffRequest } from "@/lib/offRequestWindowService";

export const dynamic = "force-dynamic";

/** POST — 캐디 본인, OPEN, 같은 달 날짜 이동 + Adjustment */
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
    const result = await rescheduleOwnOffRequest(prisma, actor, id, {
      toDate: String(body?.toDate ?? "").trim(),
      reason: body?.reason ?? null,
    });
    return NextResponse.json({
      ok: true,
      offRequest: serializeOffRequest(result.offRequest),
      adjustmentId: result.adjustmentId,
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
