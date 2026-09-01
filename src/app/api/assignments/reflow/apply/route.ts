import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  applyLiveAssignmentChange,
  LIVE_CHANGE_APPLY_USER_MESSAGE,
  type LiveChangeInput,
} from "@/lib/assignmentChange";
import type {
  AutoAssignCaddy,
  AutoAssignResultV1,
  ReservationChangeEvent,
} from "@/lib/autoAssignEngine";
import { resolveCanonicalLivePool } from "@/lib/opsDutyLivePool";
import { loadSpecialSupportQueuesForDate } from "@/lib/dailySpecialSupportService";
import { isOffSheetUnresolvedError } from "@/lib/caddyPoolCanonicalService";
import { OFF_SHEET_UNRESOLVED_CODE } from "@/lib/caddyPoolCanonical";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/assignments/reflow/apply
 * 미리보기와 동일한 입력을 서버에서 재계산한 뒤 Reservation/Placement에 저장.
 * preview 엔드포인트는 이 경로를 호출하지 않음.
 * 현재 날짜 canonical pool/unavailable을 다시 구성한다. 2090+ fixture 날짜는 off-sheet HTTP를 건너뛴다.
 */
export async function POST(req: NextRequest) {
  const started = Date.now();
  const tAuth = Date.now();
  const guard = await requireAdmin(req);
  const authMs = Date.now() - tAuth;
  if (guard) return guard;

  try {
    const tParse = Date.now();
    const body = await req.json().catch(() => null);
    const parseMs = Date.now() - tParse;
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

    const tPool = Date.now();
    const tSupport = Date.now();
    const [poolResult, supportResult] = await Promise.all([
      resolveCanonicalLivePool(previous.date, regularCaddyPool).then(
        (resolved) => {
          previous.unavailableCaddyIds = resolved.unavailableIds;
          return { pool: resolved.computePool, ms: Date.now() - tPool };
        }
      ),
      loadSpecialSupportQueuesForDate(previous.date).then((specialSupportByShift) => ({
        specialSupportByShift,
        ms: Date.now() - tSupport,
      })),
    ]);

    const result = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: poolResult.pool,
        events,
        change,
        specialSupportByShift: supportResult.specialSupportByShift,
      },
      { ip, updateOpsIfPresent: true }
    );

    if (!result.ok) {
      const hideDetails =
        result.code !== OFF_SHEET_UNRESOLVED_CODE &&
        (result.httpStatus >= 500 || result.code === "APPLY_FAILED");
      return NextResponse.json(
        {
          error: hideDetails
            ? LIVE_CHANGE_APPLY_USER_MESSAGE
            : result.message,
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
      timings: {
        authMs,
        parseMs,
        opsDutyMs: poolResult.ms,
        specialSupportMs: supportResult.ms,
        computeMs: result.timings?.computeMs ?? null,
        persistMs: result.timings?.persistMs ?? null,
        totalMs: Date.now() - started,
        offSheetHttp: false,
        availabilityReload: false,
      },
    });
  } catch (e: unknown) {
    if (isOffSheetUnresolvedError(e)) {
      return NextResponse.json(
        { error: e.message, code: e.code, message: e.message },
        { status: e.status }
      );
    }
    console.error("[POST /api/assignments/reflow/apply]", e);
    return NextResponse.json(
      { error: LIVE_CHANGE_APPLY_USER_MESSAGE },
      { status: 500 }
    );
  }
}
