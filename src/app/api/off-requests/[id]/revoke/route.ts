import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { revokeOffRequest, serializeOffRequest } from "@/lib/offRequestService";

export const dynamic = "force-dynamic";

/** POST — 승인 취소 (연결된 Assignment OFF만 삭제, OffRequest 이력 보존) */
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
    const updated = await revokeOffRequest(prisma, actor, id);
    return NextResponse.json({
      ok: true,
      offRequest: serializeOffRequest(updated),
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
