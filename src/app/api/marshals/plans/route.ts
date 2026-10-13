import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { marshalErrorResponse } from "@/lib/marshalRosterService";
import {
  getMonthPlan,
  upsertMonthPlanSettings,
} from "@/lib/marshalRotationService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function ipOf(req: NextRequest): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const url = new URL(req.url);
    const data = await getMonthPlan({
      year: url.searchParams.get("year"),
      month: url.searchParams.get("month"),
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/marshals/plans", error);
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const auth = await resolveAuthUser(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON 필요" }, { status: 400 });
    }
    const data = await upsertMonthPlanSettings({
      ...(body as Record<string, unknown>),
      actor: {
        userId: auth?.id ?? null,
        username: auth?.username ?? null,
        ip: ipOf(req),
      },
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("PUT /api/marshals/plans", error);
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
