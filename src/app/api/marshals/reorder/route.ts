import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import {
  marshalErrorResponse,
  reorderMarshalProfiles,
} from "@/lib/marshalRosterService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function ipOf(req: NextRequest): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const auth = await resolveAuthUser(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON 필요" }, { status: 400 });
    }
    const marshals = await reorderMarshalProfiles({
      items: (body as { items?: unknown }).items,
      actor: {
        userId: auth?.id ?? null,
        username: auth?.username ?? null,
        ip: ipOf(req),
      },
    });
    return NextResponse.json({ marshals });
  } catch (error) {
    console.error("POST /api/marshals/reorder", error);
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
