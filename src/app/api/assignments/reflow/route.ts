import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  reflowRegularAssignments,
  type AutoAssignCaddy,
  type AutoAssignResultV1,
  type ReservationChangeEvent,
} from "@/lib/autoAssignEngine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST JSON — 일반 순번 reflow preview (DB write 없음)
 * body: { previous, regularCaddyPool, events }
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }

    const previous = body.previous as AutoAssignResultV1 | undefined;
    const regularCaddyPool = body.regularCaddyPool as AutoAssignCaddy[] | undefined;
    const events = body.events as ReservationChangeEvent[] | undefined;

    if (!previous || !previous.date) {
      return NextResponse.json({ error: "previous 결과 필요" }, { status: 400 });
    }
    if (!Array.isArray(regularCaddyPool)) {
      return NextResponse.json(
        { error: "regularCaddyPool[] 필요" },
        { status: 400 }
      );
    }
    if (!Array.isArray(events)) {
      return NextResponse.json({ error: "events[] 필요" }, { status: 400 });
    }

    const result = reflowRegularAssignments({
      previous,
      regularCaddyPool,
      events,
    });

    return NextResponse.json({ mode: "reflow", ...result });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "reflow 실패";
    console.error("[POST /api/assignments/reflow]", e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
