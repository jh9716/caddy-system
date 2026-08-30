/**
 * Next-move intent buffer (max 1).
 * Does not persist a second MOVE until the in-flight atomic quick-move is
 * server-confirmed. Recomputes the pending MOVE on that confirmed Draft.
 * Not a multi-optimistic persist queue.
 */
import {
  applyLiveResultToDraft,
  autoResultFromDraft,
  type AssignmentDraft,
} from "@/lib/assignmentDraft";
import {
  makeMoveReservationChange,
  previewLiveChangeFromDraft,
  type LiveChangeInput,
  type LiveChangePreview,
} from "@/lib/assignmentChange";
import {
  parseAssignShiftPart,
  resolveCourseCode,
  type AutoAssignCaddy,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
} from "@/lib/autoAssignEngine";
import { reservationMatchesIdentity } from "@/lib/reservationIdentity";
import {
  parseMoveDestination,
  type ReservationMoveDest,
} from "@/lib/reservationMove";
import type { ShiftPart } from "@/lib/reservationParser";

export type NextMoveIntent = {
  sourceKey: string;
  sourceId?: string | number | null;
  dest: ReservationMoveDest;
};

export type NextMoveBlockCode =
  | "DEST_INVALID"
  | "SOURCE_MISSING"
  | "DEST_OCCUPIED"
  | "PREVIEW_BLOCKED";

export const NEXT_MOVE_WAITING_LABEL = "대기 중";
export const NEXT_MOVE_WAITING_FULL = "다음 이동 대기 중";
export const NEXT_MOVE_CANCELLED_AFTER_FAIL_TOAST =
  "앞선 이동을 저장하지 못해 다음 이동은 적용하지 않았습니다.";
export const NEXT_MOVE_DEST_OCCUPIED_TOAST =
  "목적 칸이 이미 사용 중이라 다음 이동은 적용하지 않았습니다.";
export const NEXT_MOVE_SOURCE_GONE_TOAST =
  "이동할 팀을 찾지 못해 다음 이동은 적용하지 않았습니다.";
export const NEXT_MOVE_PENDING_CANCELLED_TOAST = "다음 이동 대기를 취소했습니다";

export function nextMoveIntentFromChange(
  change: LiveChangeInput
): NextMoveIntent | null {
  if (change.type !== "MOVE_RESERVATION") return null;
  const dest = parseMoveDestination(change.to);
  if (!dest) return null;
  const sourceKey = String(change.reservationKey || "").trim();
  const sourceId = change.reservationId ?? null;
  if (!sourceKey && (sourceId == null || String(sourceId).trim() === "")) {
    return null;
  }
  return { sourceKey, sourceId, dest };
}

export function replacePendingNextMove(
  _current: NextMoveIntent | null,
  next: NextMoveIntent
): NextMoveIntent {
  return next;
}

export function resolvePendingAfterLeadingPersist(input: {
  leadingOk: boolean;
  pending: NextMoveIntent | null;
}): {
  pending: NextMoveIntent | null;
  autoRun: boolean;
  toast: string | null;
} {
  if (!input.pending) {
    return { pending: null, autoRun: false, toast: null };
  }
  if (!input.leadingOk) {
    return {
      pending: null,
      autoRun: false,
      toast: NEXT_MOVE_CANCELLED_AFTER_FAIL_TOAST,
    };
  }
  return { pending: input.pending, autoRun: true, toast: null };
}

export function assignmentSlot(row: AutoAssignmentRow): {
  course: string | null;
  shift: ReturnType<typeof parseAssignShiftPart>;
  teeTime: string;
} {
  return {
    course: resolveCourseCode(String(row.reservation.course || "")),
    shift: parseAssignShiftPart(row.shift || row.reservation.shift),
    teeTime: String(row.reservation.teeTime || ""),
  };
}

export function findIntentSourceOnDraft(
  draft: AssignmentDraft,
  intent: NextMoveIntent
): AutoAssignmentRow | null {
  return (
    draft.assignments.find((row) =>
      reservationMatchesIdentity(
        row.reservation,
        intent.sourceKey,
        intent.sourceId
      )
    ) || null
  );
}

export function destOccupiedOnDraft(
  draft: AssignmentDraft,
  dest: ReservationMoveDest
): boolean {
  return draft.assignments.some((row) => {
    const slot = assignmentSlot(row);
    return (
      slot.course === dest.course &&
      slot.shift === dest.shift &&
      slot.teeTime === dest.teeTime
    );
  });
}

export function validateNextMoveIntentOnDraft(
  draft: AssignmentDraft,
  intent: NextMoveIntent
):
  | { ok: true; change: LiveChangeInput; source: AutoAssignmentRow }
  | { ok: false; code: NextMoveBlockCode; message: string } {
  const dest = parseMoveDestination(intent.dest);
  if (!dest) {
    return {
      ok: false,
      code: "DEST_INVALID",
      message: "목적 부/코스/티타임을 확인하세요.",
    };
  }
  const source = findIntentSourceOnDraft(draft, intent);
  if (!source) {
    return {
      ok: false,
      code: "SOURCE_MISSING",
      message: NEXT_MOVE_SOURCE_GONE_TOAST,
    };
  }
  const sourceSlot = assignmentSlot(source);
  const movingOntoSelf =
    sourceSlot.course === dest.course &&
    sourceSlot.shift === dest.shift &&
    sourceSlot.teeTime === dest.teeTime;
  if (!movingOntoSelf && destOccupiedOnDraft(draft, dest)) {
    return {
      ok: false,
      code: "DEST_OCCUPIED",
      message: NEXT_MOVE_DEST_OCCUPIED_TOAST,
    };
  }
  return {
    ok: true,
    source,
    change: makeMoveReservationChange({
      reservationKey: intent.sourceKey || undefined,
      reservationId: intent.sourceId ?? source.reservation.id,
      to: { ...dest, date: draft.date },
    }),
  };
}

export function prepareNextMoveOnConfirmedDraft(input: {
  confirmedDraft: AssignmentDraft;
  intent: NextMoveIntent;
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
}):
  | {
      ok: true;
      change: LiveChangeInput;
      preview: LiveChangePreview;
      painted: AssignmentDraft;
      previous: AutoAssignResultV1;
    }
  | { ok: false; code: NextMoveBlockCode; message: string } {
  const validated = validateNextMoveIntentOnDraft(
    input.confirmedDraft,
    input.intent
  );
  if (!validated.ok) return validated;
  const previous = autoResultFromDraft(input.confirmedDraft, null);
  const preview = previewLiveChangeFromDraft({
    draft: input.confirmedDraft,
    base: previous,
    change: validated.change,
    specialSupportByShift: input.specialSupportByShift,
  });
  const blocking = preview.warnings.find((w) => w.level === "error");
  if (blocking) {
    return {
      ok: false,
      code: "PREVIEW_BLOCKED",
      message: blocking.message || NEXT_MOVE_DEST_OCCUPIED_TOAST,
    };
  }
  return {
    ok: true,
    change: validated.change,
    preview,
    painted: applyLiveResultToDraft(input.confirmedDraft, preview.after),
    previous,
  };
}

function allowQuickMoveTestKnobs(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1") return true;
  return typeof process === "undefined" || process.env.NODE_ENV !== "production";
}

export function readQuickMoveTestDelayMs(
  search = typeof window !== "undefined" ? window.location.search : "",
  host = typeof window !== "undefined" ? window.location.hostname : ""
): number {
  if (!allowQuickMoveTestKnobs(host)) return 0;
  const fromQuery = Number(new URLSearchParams(search).get("quickMoveDelay"));
  if (Number.isFinite(fromQuery) && fromQuery > 0 && fromQuery <= 10000) {
    return Math.floor(fromQuery);
  }
  const fromEnv = Number(
    typeof process !== "undefined" ? process.env.QUICK_MOVE_TEST_DELAY_MS || 0 : 0
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 10000) {
    return Math.floor(fromEnv);
  }
  return 0;
}

export function readQuickMoveTestFail(
  search = typeof window !== "undefined" ? window.location.search : "",
  host = typeof window !== "undefined" ? window.location.hostname : ""
): "error" | null {
  if (!allowQuickMoveTestKnobs(host)) return null;
  const raw = String(
    new URLSearchParams(search).get("quickMoveFail") || ""
  ).trim();
  if (raw === "1" || raw === "live" || raw === "error") return "error";
  return null;
}
