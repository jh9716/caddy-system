import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import {
  serializeOffRequestWindow,
  updateOffRequestWindow,
} from "@/lib/offRequestWindowService";

export const dynamic = "force-dynamic";

function parseId(raw: string) {
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("invalid_id");
  }
  return id;
}

/** PATCH — admin, DRAFT 일정/defaultQuota */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const params = await Promise.resolve(ctx.params);
    const id = parseId(params.id);
    const body = await req.json().catch(() => ({}));
    const updated = await updateOffRequestWindow(prisma, actor, id, {
      openAt: body?.openAt,
      closeAt: body?.closeAt,
      defaultQuota: body?.defaultQuota,
    });
    return NextResponse.json({
      ok: true,
      window: serializeOffRequestWindow(updated),
    });
  } catch (e) {
    if (e instanceof Error && e.message === "invalid_id") {
      return NextResponse.json(
        { error: "invalid_id", message: "id 필요" },
        { status: 400 }
      );
    }
    return offRequestErrorResponse(e);
  }
}
