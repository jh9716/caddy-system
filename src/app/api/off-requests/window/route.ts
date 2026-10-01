import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import {
  createOffRequestWindow,
  getOffRequestWindow,
  serializeOffRequestWindow,
} from "@/lib/offRequestWindowService";

export const dynamic = "force-dynamic";

/** GET — 월별 window. 없으면 window=null */
export async function GET(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const month = req.nextUrl.searchParams.get("month")?.trim() || "";
    const window = await getOffRequestWindow(prisma, month);
    return NextResponse.json({
      ok: true,
      month,
      window: window ? serializeOffRequestWindow(window) : null,
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}

/** POST — admin DRAFT 생성 */
export async function POST(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const body = await req.json().catch(() => ({}));
    const created = await createOffRequestWindow(prisma, actor, {
      yearMonth: String(body?.yearMonth ?? "").trim(),
      openAt: String(body?.openAt ?? "").trim(),
      closeAt: String(body?.closeAt ?? "").trim(),
      defaultQuota: body?.defaultQuota,
    });
    return NextResponse.json(
      { ok: true, window: serializeOffRequestWindow(created) },
      { status: 201 }
    );
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
