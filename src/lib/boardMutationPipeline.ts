/**
 * Board Mutation Pipeline v1.
 * confirmedDraft + pending intents. Screen = confirmed + pending projection.
 * Server writes are serial. Never overwrite latest state with a stale optimistic Draft.
 */

import {
  applyLiveResultToDraft,
  autoResultFromDraft,
  confirmedDraftKeepingPlacedUnavailable,
  liveClickSnapshotPool,
  type AssignmentDraft,
} from "@/lib/assignmentDraft";
import {
  previewLiveChangeFromDraft,
  type LiveChangeInput,
  type LiveChangePreview,
} from "@/lib/assignmentChange";
import type { AutoAssignCaddy, AutoAssignResultV1 } from "@/lib/autoAssignEngine";
import type { ShiftPart } from "@/lib/reservationParser";

export const PIPELINE_MUTATION_TYPES = [
  "MOVE_RESERVATION",
  "CADDY_SICK",
  "CADDY_ATTENDANCE_NOSHOW",
] as const;

export type PipelineMutationType = (typeof PIPELINE_MUTATION_TYPES)[number];

export type BoardMutationIntent = {
  id: string;
  change: LiveChangeInput;
};

export type PrepareIntentResult =
  | {
      ok: true;
      intent: BoardMutationIntent;
      preview: LiveChangePreview;
      painted: AssignmentDraft;
      previous: AutoAssignResultV1;
    }
  | { ok: false; intent: BoardMutationIntent; message: string; code: string };

export const PIPELINE_SAVING_LABEL = "저장 중";
export const PIPELINE_SAVING_FULL = "변경사항 저장 중";
export const PIPELINE_INTENT_DROPPED_TOAST =
  "앞선 저장 이후 이 변경은 적용할 수 없어 취소했습니다.";
export const PIPELINE_LEADING_FAIL_TOAST =
  "이 변경은 저장하지 못했습니다. 이미 확정된 배치는 유지합니다.";

export function isPipelineMutation(
  type: string | undefined | null
): type is PipelineMutationType {
  return (
    type === "MOVE_RESERVATION" ||
    type === "CADDY_SICK" ||
    type === "CADDY_ATTENDANCE_NOSHOW"
  );
}

export function makeMutationIntent(
  change: LiveChangeInput,
  id: string
): BoardMutationIntent | null {
  if (!isPipelineMutation(change.type)) return null;
  return { id, change };
}

export function isDuplicateCaddyAbsenceIntent(
  pending: readonly BoardMutationIntent[],
  change: LiveChangeInput
): boolean {
  if (change.type !== "CADDY_SICK" && change.type !== "CADDY_ATTENDANCE_NOSHOW") {
    return false;
  }
  const caddyId = Number(change.caddyId);
  if (!(caddyId > 0)) return false;
  return pending.some((row) => {
    const type = row.change.type;
    if (type !== "CADDY_SICK" && type !== "CADDY_ATTENDANCE_NOSHOW") return false;
    return Number(row.change.caddyId) === caddyId;
  });
}

export function scheduleAfterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      setTimeout(fn, 0);
    });
    return;
  }
  setTimeout(fn, 0);
}

export function prepareIntentOnConfirmedDraft(input: {
  confirmedDraft: AssignmentDraft;
  intent: BoardMutationIntent;
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
  base?: AutoAssignResultV1 | null;
  regularCaddyPool?: AutoAssignCaddy[];
}): PrepareIntentResult {
  const change = input.intent.change;
  if (change.type === "CADDY_SICK" || change.type === "CADDY_ATTENDANCE_NOSHOW") {
    const caddyId = Number(change.caddyId);
    const stillOnBoard = input.confirmedDraft.assignments.some(
      (row) => row.caddy.id === caddyId
    );
    if (!stillOnBoard) {
      return {
        ok: false,
        intent: input.intent,
        message: PIPELINE_INTENT_DROPPED_TOAST,
        code: "CADDY_ALREADY_GONE",
      };
    }
  }
  const confirmedDraft = confirmedDraftKeepingPlacedUnavailable(
    input.confirmedDraft
  );
  const previous = autoResultFromDraft(confirmedDraft, input.base ?? null);
  const regularCaddyPool =
    input.regularCaddyPool ??
    liveClickSnapshotPool(input.confirmedDraft, {
      base: input.base ?? null,
      liveUnavailableIds: input.confirmedDraft.unavailableCaddyIds,
    });
  const preview = previewLiveChangeFromDraft({
    draft: confirmedDraft,
    base: input.base ?? null,
    change: input.intent.change,
    specialSupportByShift: input.specialSupportByShift,
    regularCaddyPool,
  });
  const blocking = preview.warnings.find((w) => w.level === "error");
  if (blocking) {
    return {
      ok: false,
      intent: input.intent,
      message: blocking.message || PIPELINE_INTENT_DROPPED_TOAST,
      code: blocking.code || "PREVIEW_BLOCKED",
    };
  }
  return {
    ok: true,
    intent: input.intent,
    preview,
    painted: applyLiveResultToDraft(confirmedDraft, preview.after),
    previous,
  };
}

export function projectPendingIntents(input: {
  confirmedDraft: AssignmentDraft;
  pending: BoardMutationIntent[];
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
  base?: AutoAssignResultV1 | null;
  regularCaddyPool?: AutoAssignCaddy[];
}): {
  draft: AssignmentDraft;
  applied: BoardMutationIntent[];
  dropped: Array<{ intent: BoardMutationIntent; message: string }>;
} {
  let draft = input.confirmedDraft;
  const applied: BoardMutationIntent[] = [];
  const dropped: Array<{ intent: BoardMutationIntent; message: string }> = [];
  for (const intent of input.pending) {
    const prepared = prepareIntentOnConfirmedDraft({
      confirmedDraft: draft,
      intent,
      specialSupportByShift: input.specialSupportByShift,
      base: input.base ?? null,
      regularCaddyPool: input.regularCaddyPool,
    });
    if (!prepared.ok) {
      dropped.push({ intent, message: prepared.message });
      continue;
    }
    draft = prepared.painted;
    applied.push(intent);
  }
  return { draft, applied, dropped };
}

/**
 * /manage/assignments enqueuePipelineMutation projection.
 * Builds the keeping-placed click pool, then projects pending intents.
 */
export function projectEnqueuedIntents(input: {
  confirmedDraft: AssignmentDraft;
  pending: BoardMutationIntent[];
  extraUsable?: readonly AutoAssignCaddy[] | null;
  liveUnavailableIds?: Iterable<unknown>;
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
  base?: AutoAssignResultV1 | null;
  opsDutyIds?: Iterable<unknown>;
}): {
  draft: AssignmentDraft;
  applied: BoardMutationIntent[];
  dropped: Array<{ intent: BoardMutationIntent; message: string }>;
  regularCaddyPool: AutoAssignCaddy[];
} {
  const regularCaddyPool = liveClickSnapshotPool(input.confirmedDraft, {
    extraUsable: input.extraUsable,
    liveUnavailableIds: input.liveUnavailableIds,
    base: input.base ?? null,
    opsDutyIds: input.opsDutyIds,
  });
  const projected = projectPendingIntents({
    confirmedDraft: input.confirmedDraft,
    pending: input.pending,
    specialSupportByShift: input.specialSupportByShift,
    base: input.base ?? null,
    regularCaddyPool,
  });
  return { ...projected, regularCaddyPool };
}

export function dropIntent(
  pending: BoardMutationIntent[],
  intentId: string
): BoardMutationIntent[] {
  return pending.filter((row) => row.id !== intentId);
}

/** Dock preview has events + changeType, not the original LiveChangeInput. */
export function changeFromPipelinePreview(
  preview: LiveChangePreview
): LiveChangeInput | null {
  if (!isPipelineMutation(preview.changeType)) return null;
  const ev = preview.events[0];
  if (!ev) return null;
  if (preview.changeType === "MOVE_RESERVATION" && ev.type === "MOVE_RESERVATION") {
    return {
      type: "MOVE_RESERVATION",
      reservationKey: ev.reservationKey,
      reservationId: ev.reservationId,
      to: ev.to,
    };
  }
  if (
    (preview.changeType === "CADDY_SICK" ||
      preview.changeType === "CADDY_ATTENDANCE_NOSHOW") &&
    ev.type === "REMOVE_CADDY"
  ) {
    return {
      type: preview.changeType,
      caddyId: ev.caddyId,
      shift: ev.fromShift,
      note: ev.note,
    };
  }
  return null;
}

function allowPipelineTestKnobs(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (host) return false;
  return typeof process === "undefined" || process.env.NODE_ENV !== "production";
}

export function readPipelineTestDelayMs(
  search = typeof window !== "undefined" ? window.location.search : "",
  host = typeof window !== "undefined" ? window.location.hostname : ""
): number {
  if (!allowPipelineTestKnobs(host)) return 0;
  const fromQuery = Number(new URLSearchParams(search).get("pipelineDelay"));
  if (Number.isFinite(fromQuery) && fromQuery > 0 && fromQuery <= 10000) {
    return Math.floor(fromQuery);
  }
  return 0;
}

export function readPipelineTestFail(
  search = typeof window !== "undefined" ? window.location.search : "",
  host = typeof window !== "undefined" ? window.location.hostname : ""
): "move" | "sick" | "error" | null {
  if (!allowPipelineTestKnobs(host)) return null;
  const raw = String(
    new URLSearchParams(search).get("pipelineFail") || ""
  ).trim();
  if (raw === "move") return "move";
  if (raw === "sick") return "sick";
  if (raw === "1" || raw === "error") return "error";
  return null;
}
