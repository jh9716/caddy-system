import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import {
  LIVE_CHANGE_APPLY_USER_MESSAGE,
  type LiveChangeInput,
  type LiveChangeType,
} from "@/lib/assignmentChange";
import type {
  AutoAssignCaddy,
  AutoAssignResultV1,
  ReservationChangeEvent,
} from "@/lib/autoAssignEngine";
import { resolveCanonicalLivePool } from "@/lib/opsDutyLivePool";
import { loadSpecialSupportQueuesForDate } from "@/lib/dailySpecialSupportService";
import { applyQuickBoardMutation } from "@/lib/quickBoardMutationApply";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/assignments/reflow/quick-mutation
 * MOVE / SICK / ABSENT: live rewrite + Draft version check/save in one transaction.
 */
export async function POST(req: NextRequest) {
  const started = Date.now();
  const tAuth = Date.now();
  const guard = await requireAdmin(req);
  const authMs = Date.now() - tAuth;
  if (guard) return guard;
  const auth = await resolveAuthUser(req);

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
    const draft = (body as { draft?: { date?: unknown; version?: unknown; payload?: unknown } })
      .draft;

    if (!previous || !previous.date) {
      return NextResponse.json({ error: "previous 결과 필요" }, { status: 400 });
    }
    if (!Array.isArray(regularCaddyPool)) {
      return NextResponse.json(
        { error: "regularCaddyPool[] 필요" },
        { status: 400 }
      );
    }
    if (!draft || typeof draft !== "object") {
      return NextResponse.json({ error: "draft { date, version, payload } 필요" }, { status: 400 });
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;

    const payloadPool = Array.isArray(
      (draft.payload as { caddyPool?: unknown } | undefined)?.caddyPool
    )
      ? ((draft.payload as { caddyPool: AutoAssignCaddy[] }).caddyPool)
      : regularCaddyPool;

    const tPool = Date.now();
    const tSupport = Date.now();
    const [poolResult, supportResult] = await Promise.all([
      resolveCanonicalLivePool(previous.date, regularCaddyPool, {
        offSheetMode: "cache",
        rosterClientPool: payloadPool,
        computeClientPool: regularCaddyPool,
      }).then((resolved) => {
        previous.unavailableCaddyIds = resolved.unavailableIds;
        return {
          canonical: resolved,
          pool: resolved.computePool,
          ms: Date.now() - tPool,
        };
      }),
      loadSpecialSupportQueuesForDate(previous.date).then((specialSupportByShift) => ({
        specialSupportByShift,
        ms: Date.now() - tSupport,
      })),
    ]);

    const result = await applyQuickBoardMutation({
      previous,
      regularCaddyPool: poolResult.pool,
      canonical: poolResult.canonical,
      skipCanonicalReload: true,
      events,
      change,
      changeType: (body as { changeType?: LiveChangeType }).changeType,
      specialSupportByShift: supportResult.specialSupportByShift,
      draft: {
        date: String(draft.date || previous.date),
        expectedVersion: Number(draft.version),
        payload: draft.payload,
      },
      updatedByUserId: auth?.userId ?? null,
      ip,
      testFailLive: (body as { testFailLive?: "error" | null }).testFailLive,
      testFailDraft: (body as { testFailDraft?: "error" | null }).testFailDraft,
      testDelayMs: Number((body as { testDelayMs?: unknown }).testDelayMs || 0),
    });

    if (!result.ok) {
      const hideDetails =
        result.httpStatus >= 500 || result.code === "APPLY_FAILED";
      return NextResponse.json(
        {
          error: hideDetails
            ? LIVE_CHANGE_APPLY_USER_MESSAGE
            : result.message,
          code: hideDetails ? "APPLY_FAILED" : result.code,
          message: hideDetails ? undefined : result.message,
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
      draft: result.draft,
      timings: {
        authMs,
        parseMs,
        opsDutyMs: poolResult.ms,
        specialSupportMs: supportResult.ms,
        computeMs: result.timings?.computeMs ?? null,
        persistMs: result.timings?.persistMs ?? null,
        totalMs: Date.now() - started,
        offSheetHttp: false,
        offSheetSource: poolResult.canonical.offSheetSource,
        availabilityReload: false,
      },
    });
  } catch (e: unknown) {
    console.error("[POST /api/assignments/reflow/quick-mutation]", e);
    return NextResponse.json(
      { error: LIVE_CHANGE_APPLY_USER_MESSAGE, code: "APPLY_FAILED" },
      { status: 500 }
    );
  }
}
