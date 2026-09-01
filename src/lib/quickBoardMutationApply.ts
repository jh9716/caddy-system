/**
 * Atomic persist for pipeline mutations: MOVE / SICK / ABSENT.
 * Reservation/Placement/Unavailable + Draft version check/save in one transaction.
 * #104 quick-move stays MOVE-only via applyQuickReservationMove.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { isLocalDatabaseUrl } from "@/lib/dbSafety";
import { parseYmd } from "@/lib/availabilityEngine";
import {
  LIVE_CHANGE_APPLY_USER_MESSAGE,
  LiveChangePersistError,
  buildLiveChangePersistPlan,
  eventsFromLiveChange,
  previewLiveAssignmentEvents,
  writeLiveChangePlan,
  type ApplyLiveChangeResult,
  type LiveChangeInput,
  type LiveChangeType,
} from "@/lib/assignmentChange";
import type {
  AutoAssignCaddy,
  AutoAssignResultV1,
  ReservationChangeEvent,
} from "@/lib/autoAssignEngine";
import type { ShiftPart } from "@/lib/reservationParser";
import {
  DailyBoardDraftConflictError,
  DailyBoardDraftPayloadError,
  saveDailyBoardDraftOnDb,
  type DailyBoardDraftRecord,
} from "@/lib/dailyBoardDraftService";
import { applyLiveResultToDraft } from "@/lib/assignmentDraft";
import {
  assignmentDraftToPayload,
  parseDailyBoardDraftPayload,
  payloadToAssignmentDraft,
  type DailyBoardDraftPayloadV1,
} from "@/lib/dailyBoardDraft";
import {
  isPipelineMutation,
  type PipelineMutationType,
} from "@/lib/boardMutationPipeline";
import {
  QUICK_MOVE_DRAFT_FORCE_FAIL,
  QUICK_MOVE_LIVE_FORCE_FAIL,
  type QuickMoveApplyResult,
} from "@/lib/quickReservationMoveApply";
import {
  isOffSheetUnresolvedError,
  loadCanonicalReflowState,
  type CanonicalReflowState,
} from "@/lib/caddyPoolCanonicalService";
import { resolveCanonicalUnavailableIds } from "@/lib/caddyPoolCanonical";

export const QUICK_MUTATION_TYPES: PipelineMutationType[] = [
  "MOVE_RESERVATION",
  "CADDY_SICK",
  "CADDY_ATTENDANCE_NOSHOW",
];

function allowLocalTestFail(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    isLocalDatabaseUrl(process.env.DATABASE_URL)
  );
}

export async function applyQuickBoardMutation(input: {
  previous: AutoAssignResultV1;
  regularCaddyPool: AutoAssignCaddy[];
  events?: ReservationChangeEvent[];
  change?: LiveChangeInput;
  changeType?: LiveChangeType;
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
  draft: {
    date: string;
    expectedVersion: number;
    payload: unknown;
  };
  updatedByUserId: number | null;
  ip?: string | null;
  testFailLive?: "error" | null;
  testFailDraft?: "error" | null;
  testDelayMs?: number;
  allowedTypes?: PipelineMutationType[];
  prisma?: PrismaClient;
  canonical?: CanonicalReflowState;
  skipCanonicalReload?: boolean;
}): Promise<QuickMoveApplyResult> {
  const events =
    input.events ||
    (input.change ? eventsFromLiveChange(input.change) : []);
  if (events.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      code: "EMPTY_EVENTS",
      message: "변경 이벤트가 없습니다.",
    };
  }
  if (input.draft.date !== input.previous.date) {
    return {
      ok: false,
      httpStatus: 400,
      code: "DATE_MISMATCH",
      message: "Draft 날짜와 배치 날짜가 다릅니다.",
    };
  }

  const computeStarted = Date.now();
  const db = input.prisma ?? defaultPrisma;
  let computePool = input.regularCaddyPool;
  let rosterBaseline = input.regularCaddyPool;
  let storedUnavailable: number[] = [];
  if (input.skipCanonicalReload && input.canonical) {
    computePool = input.canonical.computePool;
    rosterBaseline = input.canonical.rosterBaseline;
    storedUnavailable = input.canonical.unavailableIds;
  } else {
    try {
      const canonical = await loadCanonicalReflowState(
        input.previous.date,
        input.regularCaddyPool,
        db,
        { offSheetMode: "cache-or-fetch" }
      );
      computePool = canonical.computePool;
      rosterBaseline = canonical.rosterBaseline;
      storedUnavailable = canonical.unavailableIds;
    } catch (error) {
      if (isOffSheetUnresolvedError(error)) {
        return {
          ok: false,
          httpStatus: error.status,
          code: error.code,
          message: error.message,
        };
      }
      storedUnavailable =
        typeof db.dailyCaddyUnavailable?.findMany === "function"
          ? (
              await db.dailyCaddyUnavailable.findMany({
                where: { date: parseYmd(input.previous.date).start },
                select: { caddyId: true },
              })
            ).map((row) => Number(row.caddyId))
          : [];
    }
  }
  const previous = {
    ...input.previous,
    unavailableCaddyIds: resolveCanonicalUnavailableIds({
      dailyUnavailableIds: storedUnavailable,
    }),
  };
  const preview = previewLiveAssignmentEvents({
    previous,
    regularCaddyPool: computePool,
    events,
    changeType: input.changeType || input.change?.type,
    specialSupportByShift: input.specialSupportByShift,
  });
  const computeMs = Date.now() - computeStarted;
  const blocking = preview.warnings.filter((w) => w.level === "error");
  if (blocking.length > 0) {
    return {
      ok: false,
      httpStatus: 400,
      code: blocking[0].code,
      message: blocking[0].message,
      warnings: preview.warnings,
    };
  }
  const allowed = input.allowedTypes || QUICK_MUTATION_TYPES;
  if (
    !preview.changeType ||
    !isPipelineMutation(preview.changeType) ||
    !allowed.includes(preview.changeType)
  ) {
    return {
      ok: false,
      httpStatus: 400,
      code: "NOT_PIPELINE_MUTATION",
      message: "이 저장 경로는 팀 이동/병가/결근만 처리합니다.",
    };
  }

  let payload: DailyBoardDraftPayloadV1;
  try {
    payload = parseDailyBoardDraftPayload(input.draft.payload, input.draft.date);
    const synced = applyLiveResultToDraft(
      payloadToAssignmentDraft(payload),
      preview.after
    );
    payload = {
      ...assignmentDraftToPayload(synced),
      caddyPool: rosterBaseline.length > 0 ? rosterBaseline : synced.caddyPool,
      ...(preview.unavailableCaddyIds.length > 0
        ? { unavailableCaddyIds: preview.unavailableCaddyIds }
        : { unavailableCaddyIds: [] }),
    };
  } catch (e) {
    return {
      ok: false,
      httpStatus: 400,
      code: e instanceof DailyBoardDraftPayloadError ? e.code : "DRAFT_PAYLOAD",
      message: e instanceof Error ? e.message : "Draft payload가 올바르지 않습니다.",
    };
  }

  const plan = buildLiveChangePersistPlan(preview);
  const delayMs = Number(input.testDelayMs || 0);
  if (delayMs > 0 && isLocalDatabaseUrl(process.env.DATABASE_URL)) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(Math.floor(delayMs), 10000))
    );
  }
  const persistStarted = Date.now();
  try {
    const written = await db.$transaction(
      async (tx) => {
        if (input.testFailLive === "error") {
          if (!allowLocalTestFail()) {
            throw new Error(LIVE_CHANGE_APPLY_USER_MESSAGE);
          }
          throw new Error(QUICK_MOVE_LIVE_FORCE_FAIL);
        }
        const live = await writeLiveChangePlan(tx, plan, preview, {
          ip: input.ip ?? null,
          updateOpsIfPresent: true,
        });
        if (input.testFailDraft === "error") {
          if (!allowLocalTestFail()) {
            throw new Error(LIVE_CHANGE_APPLY_USER_MESSAGE);
          }
          throw new Error(QUICK_MOVE_DRAFT_FORCE_FAIL);
        }
        const draft = await saveDailyBoardDraftOnDb(tx, {
          date: input.draft.date,
          expectedVersion: input.draft.expectedVersion,
          payload,
          updatedByUserId: input.updatedByUserId,
        });
        return { live, draft };
      },
      { maxWait: 10_000, timeout: 20_000 }
    );
    return {
      ok: true,
      changeId: written.live.changeId,
      date: plan.date,
      opsUpdated: written.live.opsUpdated,
      preview,
      draft: written.draft,
      timings: {
        computeMs,
        persistMs: Date.now() - persistStarted,
      },
    };
  } catch (e) {
    if (e instanceof DailyBoardDraftConflictError) {
      return {
        ok: false,
        httpStatus: 409,
        code: e.code,
        message: e.message,
      };
    }
    if (e instanceof DailyBoardDraftPayloadError) {
      return {
        ok: false,
        httpStatus: 400,
        code: e.code,
        message: e.message,
      };
    }
    if (e instanceof LiveChangePersistError) {
      return {
        ok: false,
        httpStatus: e.httpStatus,
        code: e.code,
        message: e.message,
      };
    }
    if (e instanceof Error && e.message === QUICK_MOVE_LIVE_FORCE_FAIL) {
      return {
        ok: false,
        httpStatus: 500,
        code: QUICK_MOVE_LIVE_FORCE_FAIL,
        message: LIVE_CHANGE_APPLY_USER_MESSAGE,
      };
    }
    if (e instanceof Error && e.message === QUICK_MOVE_DRAFT_FORCE_FAIL) {
      return {
        ok: false,
        httpStatus: 500,
        code: QUICK_MOVE_DRAFT_FORCE_FAIL,
        message: LIVE_CHANGE_APPLY_USER_MESSAGE,
      };
    }
    throw e;
  }
}
