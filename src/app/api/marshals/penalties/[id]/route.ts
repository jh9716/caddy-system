import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { marshalErrorResponse } from "@/lib/marshalRosterService";
import {
  deletePenaltyDuty,
  updatePenaltyDuty,
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

function actor(req: NextRequest, auth: { id?: number | null; username?: string | null } | null) {
  return {
    userId: auth?.id ?? null,
    username: auth?.username ?? null,
    ip: ipOf(req),
  };
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
    const penalty = await updatePenaltyDuty({
      id: resolved.id,
      ...(body as Record<string, unknown>),
      actor: actor(req, auth),
    });
    return NextResponse.json({ penalty });
  } catch (error) {
    console.error("PATCH /api/marshals/penalties/[id]", error);
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const auth = await resolveAuthUser(req);
    const resolved = await Promise.resolve(params);
    await deletePenaltyDuty({ id: resolved.id, actor: actor(req, auth) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/marshals/penalties/[id]", error);
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
