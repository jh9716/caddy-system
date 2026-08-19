import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  applyLiveAssignmentChange,
  type LiveChangeInput,
} from "@/lib/assignmentChange";
import type {
  AutoAssignCaddy,
  AutoAssignResultV1,
  ReservationChangeEvent,
} from "@/lib/autoAssignEngine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/assignments/reflow/apply
 * 미리보기와 동일한 입력을 서버에서 재계산한 뒤 Reservation/Placement에 저장.
 * preview 엔드포인트는 이 경로를 호출하지 않음.
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
    const change = body.change as LiveChangeInput | undefined;

    if (!previous || !previous.date) {
      return NextResponse.json({ error: "previous 결과 필요" }, { status: 400 });
    }
    if (!Array.isArray(regularCaddyPool)) {
      return NextResponse.json(
        { error: "regularCaddyPool[] 필요" },
        { status: 400 }
      );
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;

    const result = await applyLiveAssignmentChange(
      { previous, regularCaddyPool, events, change },
      { ip, updateOpsIfPresent: true }
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.message,
          code: result.code,
          warnings: result.warnings,
        },
        { status: result.httpStatus }
      );
    }

    return NextResponse.json({
      ok: true,
      persisted: true,
      changeId: result.changeId,
      date: result.date,
      opsUpdated: result.opsUpdated,
      preview: result.preview,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "apply 실패";
    console.error("[POST /api/assignments/reflow/apply]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
