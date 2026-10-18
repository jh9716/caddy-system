import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { marshalErrorResponse } from "@/lib/marshalRosterService";
import { previewPenaltyOccurrenceSchedule } from "@/lib/marshalPenaltyScheduleService";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    await resolveAuthUser(req);
    const resolved = await Promise.resolve(params);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON 필요" }, { status: 400 });
    }
    const preview = await previewPenaltyOccurrenceSchedule(
      {
        id: resolved.id,
        ...(body as Record<string, unknown>),
      },
      prisma
    );
    return NextResponse.json({ preview });
  } catch (error) {
    console.error(
      "POST /api/marshals/penalty-occurrences/[id]/schedule/preview",
      error
    );
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
