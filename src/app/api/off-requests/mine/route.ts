import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isActorResponse, requireOffRequestActor } from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import { listMyOffRequests, serializeOffRequest } from "@/lib/offRequestService";

export const dynamic = "force-dynamic";

/** GET — 본인 휴무 신청 목록 */
export async function GET(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const items = await listMyOffRequests(prisma, actor);
    return NextResponse.json({
      ok: true,
      items: items.map(serializeOffRequest),
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
