import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import {
  marshalErrorResponse,
  updateMarshalProfile,
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const auth = await resolveAuthUser(req);
    const resolved = await Promise.resolve(params);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON 필요" }, { status: 400 });
    }
    const marshal = await updateMarshalProfile({
      id: resolved.id,
      active: (body as { active?: unknown }).active,
      startedOn: (body as { startedOn?: unknown }).startedOn,
      rotationOrder: (body as { rotationOrder?: unknown }).rotationOrder,
      actor: {
        userId: auth?.id ?? null,
        username: auth?.username ?? null,
        ip: ipOf(req),
      },
    });
    return NextResponse.json({ marshal });
  } catch (error) {
    console.error("PATCH /api/marshals/[id]", error);
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
