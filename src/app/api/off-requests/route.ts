import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isActorResponse,
  requireOffRequestActor,
} from "@/lib/auth";
import { offRequestErrorResponse } from "@/lib/offRequestHttp";
import {
  listOffRequestsForManagers,
  serializeOffRequest,
  submitOffRequest,
} from "@/lib/offRequestService";

export const dynamic = "force-dynamic";

/** POST — 캐디 본인 휴무 신청 */
export async function POST(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const body = await req.json().catch(() => ({}));
    const date = String(body?.date ?? "").trim();
    const note = body?.note ?? null;
    if (!date) {
      return NextResponse.json(
        { error: "invalid_date", message: "date=YYYY-MM-DD 필요" },
        { status: 400 }
      );
    }
    const created = await submitOffRequest(prisma, actor, { date, note });
    return NextResponse.json(
      { ok: true, offRequest: serializeOffRequest(created) },
      { status: 201 }
    );
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}

/** GET — 조장/관리자 목록 (?date=&team=&status=) */
export async function GET(req: NextRequest) {
  const actor = await requireOffRequestActor(req);
  if (isActorResponse(actor)) return actor;

  try {
    const date = req.nextUrl.searchParams.get("date")?.trim() || "";
    const team = req.nextUrl.searchParams.get("team");
    const status = req.nextUrl.searchParams.get("status");
    if (!date) {
      return NextResponse.json(
        { error: "invalid_date", message: "date=YYYY-MM-DD 필요" },
        { status: 400 }
      );
    }
    const { items, quotaByTeam } = await listOffRequestsForManagers(
      prisma,
      actor,
      { date, team, status }
    );
    return NextResponse.json({
      ok: true,
      date,
      items: items.map((row) => ({
        ...serializeOffRequest(row),
        caddy: row.caddy,
      })),
      quotaByTeam,
    });
  } catch (e) {
    return offRequestErrorResponse(e);
  }
}
