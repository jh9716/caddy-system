import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { getOffRequestAdminProgress } from "@/lib/offRequestPhase2Service";
import { getOffRequestAdminMonth } from "@/lib/offRequestWindowService";

export const dynamic = "force-dynamic";

/** GET — admin 월간 window + 전 조 quota/현황. 신청자 이름 없음. */
export async function GET(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const month = req.nextUrl.searchParams.get("month")?.trim() || "";
    const data = await getOffRequestAdminMonth(prisma, actor, month);
    const progress = await getOffRequestAdminProgress(prisma, month);
    return NextResponse.json({ ok: true, ...data, progress });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
