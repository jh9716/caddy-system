import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import {
  closeOffRequestWindow,
  serializeOffRequestWindow,
} from "@/lib/offRequestWindowService";

export const dynamic = "force-dynamic";

/** POST — OPEN → ADJUSTING */
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
    const window = await closeOffRequestWindow(prisma, actor, id);
    return NextResponse.json({
      ok: true,
      window: serializeOffRequestWindow(window),
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
