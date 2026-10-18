import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { marshalErrorResponse } from "@/lib/marshalRosterService";
import {
  createPenaltyOccurrence,
  listPenaltyOccurrences,
} from "@/lib/marshalPenaltyOccurrenceService";
import { prisma } from "@/lib/prisma";

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
    const occurrences = await listPenaltyOccurrences(
      {
        year: url.searchParams.get("year"),
        month: url.searchParams.get("month"),
      },
      prisma
    );
    return NextResponse.json({ occurrences });
  } catch (error) {
    console.error("GET /api/marshals/penalty-occurrences", error);
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
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
    const occurrence = await createPenaltyOccurrence(
      {
        ...(body as Record<string, unknown>),
        actor: {
          userId: auth?.id ?? null,
          username: auth?.username ?? null,
          ip: ipOf(req),
        },
      },
      prisma
    );
    return NextResponse.json({ occurrence }, { status: 201 });
  } catch (error) {
    console.error("POST /api/marshals/penalty-occurrences", error);
    const { status, body } = marshalErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
