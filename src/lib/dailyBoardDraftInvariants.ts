/**
 * Daily board draft write/publish/confirm invariants.
 * Same-shift duplicate, caddy pool membership, date/shift consistency.
 * Does not re-run auto-assign. Cross-shift multi-duty is allowed.
 */

import { DailyBoardDraftPayloadError, isYmd } from "@/lib/dailyBoardDraft";
import type { DailyBoardDraftPayloadV1 } from "@/lib/dailyBoardDraft";

export const SAME_SHIFT_DUPLICATE = "SAME_SHIFT_DUPLICATE";
export const INVALID_CADDY = "INVALID_CADDY";
export const DRAFT_ASSIGNMENT_MISMATCH = "DRAFT_ASSIGNMENT_MISMATCH";

export const SAME_SHIFT_DUPLICATE_MESSAGE =
  "같은 부에 동일 캐디를 두 번 이상 배치할 수 없습니다.";
export const INVALID_CADDY_MESSAGE =
  "배치에 없는 캐디가 포함되어 있습니다.";
export const DRAFT_ASSIGNMENT_MISMATCH_MESSAGE =
  "작업본 날짜/부와 예약 정보가 일치하지 않습니다.";

export type DraftInvariantAssignment = {
  date?: string;
  shift?: string;
  caddy?: { id?: number };
  reservation?: { date?: string; shift?: string };
};

export type DraftInvariantIssue = {
  code: typeof SAME_SHIFT_DUPLICATE | typeof INVALID_CADDY | typeof DRAFT_ASSIGNMENT_MISMATCH;
  message: string;
  caddyId?: number;
};

function positiveCaddyId(value: unknown): number | null {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

export function findDailyBoardDraftInvariantIssue(input: {
  date: string;
  assignments: readonly DraftInvariantAssignment[];
  allowedCaddyIds?: Iterable<number> | null;
}): DraftInvariantIssue | null {
  const expectedDate = String(input.date || "");
  if (!isYmd(expectedDate)) {
    return {
      code: DRAFT_ASSIGNMENT_MISMATCH,
      message: DRAFT_ASSIGNMENT_MISMATCH_MESSAGE,
    };
  }

  const allowed =
    input.allowedCaddyIds == null
      ? null
      : new Set(
          [...input.allowedCaddyIds]
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0)
        );

  const seen = new Map<string, number>();
  for (const row of input.assignments) {
    const shift = String(row.shift || "");
    const caddyId = positiveCaddyId(row.caddy?.id);
    const assignmentDate = String(row.date ?? "").trim();
    const reservationDate = String(row.reservation?.date ?? "").trim();
    const reservationShift = String(row.reservation?.shift ?? "").trim();

    if (assignmentDate && assignmentDate !== expectedDate) {
      return {
        code: DRAFT_ASSIGNMENT_MISMATCH,
        message: DRAFT_ASSIGNMENT_MISMATCH_MESSAGE,
        caddyId: caddyId ?? undefined,
      };
    }
    if (reservationDate && reservationDate !== expectedDate) {
      return {
        code: DRAFT_ASSIGNMENT_MISMATCH,
        message: DRAFT_ASSIGNMENT_MISMATCH_MESSAGE,
        caddyId: caddyId ?? undefined,
      };
    }
    if (reservationShift && shift && reservationShift !== shift) {
      return {
        code: DRAFT_ASSIGNMENT_MISMATCH,
        message: DRAFT_ASSIGNMENT_MISMATCH_MESSAGE,
        caddyId: caddyId ?? undefined,
      };
    }

    if (caddyId == null) continue;
    if (allowed && !allowed.has(caddyId)) {
      return {
        code: INVALID_CADDY,
        message: INVALID_CADDY_MESSAGE,
        caddyId,
      };
    }
    if (!shift) continue;
    const key = `${shift}:${caddyId}`;
    if (seen.has(key)) {
      return {
        code: SAME_SHIFT_DUPLICATE,
        message: SAME_SHIFT_DUPLICATE_MESSAGE,
        caddyId,
      };
    }
    seen.set(key, caddyId);
  }

  return null;
}

export function assertDailyBoardDraftInvariants(
  payload: DailyBoardDraftPayloadV1
): void {
  const issue = findDailyBoardDraftInvariantIssue({
    date: payload.date,
    assignments: payload.assignments,
    allowedCaddyIds: (payload.caddyPool || []).map((c) => c.id),
  });
  if (!issue) return;
  throw new DailyBoardDraftPayloadError(issue.message, issue.code);
}
