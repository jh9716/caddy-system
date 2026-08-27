/**
 * 날짜별 배치 작업본(Draft) payload.
 * React UI 임시 상태(모달/스크롤/검색/선택)는 저장하지 않는다.
 * 당번·특수근무·휴무·3부 시작조는 별도 테이블에서 다시 읽는다.
 */

import type { AssignmentDraft, DraftStatus } from "@/lib/assignmentDraft";
import type {
  AutoAssignCaddy,
  AutoAssignmentRow,
  SpareByShift,
  UnassignedReservationRow,
} from "@/lib/autoAssignEngine";
import {
  COURSE_CODES,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export const DAILY_BOARD_DRAFT_SCHEMA_VERSION = 1 as const;

export const DRAFT_VERSION_CONFLICT = "DRAFT_VERSION_CONFLICT";
export const DRAFT_VERSION_CONFLICT_MESSAGE =
  "다른 직원이 이 날짜 배치표를 수정했습니다. 최신 내용을 다시 불러와 주세요.";

export const DRAFT_STATUSES = [
  "DRAFT",
  "EDITED",
  "CONFIRMED",
  "APPLIED",
] as const;

const SHIFT_PARTS: ShiftPart[] = ["1부", "2부", "3부"];
const ASSIGNMENT_KINDS = [
  "regular",
  "fiftyFourHole",
  "oneThree",
  "oneTwo",
  "oneMak",
  "fixed",
  "driving",
  "specialSupport",
] as const;

export type DailyBoardDraftPayloadV1 = {
  schemaVersion: typeof DAILY_BOARD_DRAFT_SCHEMA_VERSION;
  date: string;
  status: DraftStatus;
  assignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  closedCourseReservations: UnassignedReservationRow[];
  openCourses: CourseCode[];
  caddyPool: AutoAssignCaddy[];
  sparesByShift: SpareByShift[];
  confirmedAt: string | null;
  appliedAt: string | null;
  applyAuditId: number | null;
};

export class DailyBoardDraftPayloadError extends Error {
  status = 400;
  code = "DRAFT_PAYLOAD_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "DailyBoardDraftPayloadError";
  }
}

export function isYmd(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** URL date와 body date가 있으면 같아야 한다. 요청 날짜만 신뢰한다. */
export function resolveDraftRequestDate(
  queryDate: unknown,
  bodyDate?: unknown
): string | null {
  const query = typeof queryDate === "string" ? queryDate.trim() : "";
  const body = typeof bodyDate === "string" ? bodyDate.trim() : "";
  if (query && body && query !== body) return null;
  const date = query || body;
  return isYmd(date) ? date : null;
}

/** 실패한 mutation 상태는 Draft로 저장하지 않는다. */
export function draftAutosaveCandidate(input: {
  mutationSucceeded: boolean;
  draft: AssignmentDraft | null | undefined;
}): AssignmentDraft | null {
  if (!input.mutationSucceeded || !input.draft) return null;
  return input.draft;
}

export function assignmentDraftToPayload(
  draft: AssignmentDraft
): DailyBoardDraftPayloadV1 {
  if (!isYmd(draft.date)) {
    throw new DailyBoardDraftPayloadError("draft.date는 YYYY-MM-DD 이어야 합니다.");
  }
  return {
    schemaVersion: DAILY_BOARD_DRAFT_SCHEMA_VERSION,
    date: draft.date,
    status: draft.status,
    assignments: draft.assignments.map((row) => ({ ...row })),
    unassignedReservations: (draft.unassignedReservations || []).map((u) => ({
      reservation: { ...u.reservation },
      reason: u.reason,
    })),
    closedCourseReservations: (draft.closedCourseReservations || []).map((u) => ({
      reservation: { ...u.reservation },
      reason: u.reason,
    })),
    openCourses: [...(draft.openCourses || [])] as CourseCode[],
    caddyPool: (draft.caddyPool || []).map((c) => ({ ...c })),
    sparesByShift: (draft.sparesByShift || []).map((s) => ({
      shift: s.shift,
      spare1: s.spare1 ? { ...s.spare1 } : null,
      spare2: s.spare2 ? { ...s.spare2 } : null,
    })),
    confirmedAt: draft.confirmedAt ?? null,
    appliedAt: draft.appliedAt ?? null,
    applyAuditId: draft.applyAuditId ?? null,
  };
}

export function payloadToAssignmentDraft(
  payload: DailyBoardDraftPayloadV1
): AssignmentDraft {
  return {
    date: payload.date,
    status: payload.status,
    assignments: payload.assignments,
    unassignedReservations: payload.unassignedReservations,
    closedCourseReservations: payload.closedCourseReservations,
    openCourses: payload.openCourses,
    caddyPool: payload.caddyPool,
    sparesByShift: payload.sparesByShift,
    confirmedAt: payload.confirmedAt,
    appliedAt: payload.appliedAt,
    applyAuditId: payload.applyAuditId,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DailyBoardDraftPayloadError(`${label} 객체가 필요합니다.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DailyBoardDraftPayloadError(`${label} 배열이 필요합니다.`);
  }
  return value;
}

function asFiniteInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new DailyBoardDraftPayloadError(`${label} 정수가 필요합니다.`);
  }
  return n;
}

function parseCaddy(raw: unknown, label: string): AutoAssignCaddy {
  const o = asRecord(raw, label);
  const id = asFiniteInt(o.id, `${label}.id`);
  const name = String(o.name ?? "").trim();
  if (!name) throw new DailyBoardDraftPayloadError(`${label}.name이 필요합니다.`);
  return {
    id,
    name,
    team: String(o.team ?? ""),
    teamOrder: Number.isFinite(Number(o.teamOrder)) ? Number(o.teamOrder) : 0,
    ...(o.caddyType != null ? { caddyType: String(o.caddyType) } : {}),
    ...(Array.isArray(o.extraFlags) ? { extraFlags: o.extraFlags.map(String) } : {}),
    ...(o.employmentStatus != null
      ? { employmentStatus: String(o.employmentStatus) }
      : {}),
    ...(o.thirdBandSubgroup !== undefined
      ? { thirdBandSubgroup: o.thirdBandSubgroup as string | null }
      : {}),
    ...(o.inputOrder != null && Number.isFinite(Number(o.inputOrder))
      ? { inputOrder: Number(o.inputOrder) }
      : {}),
  };
}

function parseReservation(raw: unknown, label: string) {
  const o = asRecord(raw, label);
  const date = String(o.date ?? "");
  if (date && !isYmd(date)) {
    throw new DailyBoardDraftPayloadError(`${label}.date는 YYYY-MM-DD 이어야 합니다.`);
  }
  return {
    ...(o.id !== undefined ? { id: o.id as string | number } : {}),
    date,
    course: String(o.course ?? ""),
    ...(o.courseLabel != null ? { courseLabel: String(o.courseLabel) } : {}),
    shift: String(o.shift ?? ""),
    teeTime: String(o.teeTime ?? ""),
    teamName: o.teamName == null ? null : String(o.teamName),
    ...(o.hole !== undefined ? { hole: o.hole as number | null } : {}),
    ...(o.startingHole !== undefined
      ? { startingHole: o.startingHole as number | null }
      : {}),
    ...(o.sourceSheet != null ? { sourceSheet: String(o.sourceSheet) } : {}),
    ...(o.rawRowIndex !== undefined
      ? { rawRowIndex: o.rawRowIndex as number | undefined }
      : {}),
    ...(typeof o.needsReview === "boolean" ? { needsReview: o.needsReview } : {}),
    ...(typeof o.isDuplicate === "boolean" ? { isDuplicate: o.isDuplicate } : {}),
    ...(Array.isArray(o.reviewReasons)
      ? { reviewReasons: o.reviewReasons.map(String) }
      : {}),
    ...(typeof o.limousineCart === "boolean"
      ? { limousineCart: o.limousineCart }
      : {}),
  };
}

function parseUnassigned(
  raw: unknown,
  label: string
): UnassignedReservationRow {
  const o = asRecord(raw, label);
  return {
    reservation: parseReservation(o.reservation, `${label}.reservation`),
    reason: String(o.reason ?? ""),
  };
}

function parseAssignment(raw: unknown, label: string): AutoAssignmentRow {
  const o = asRecord(raw, label);
  const kind = String(o.kind ?? "regular");
  if (!ASSIGNMENT_KINDS.includes(kind as (typeof ASSIGNMENT_KINDS)[number])) {
    throw new DailyBoardDraftPayloadError(`${label}.kind가 올바르지 않습니다.`);
  }
  const shift = String(o.shift ?? "") as ShiftPart;
  if (!SHIFT_PARTS.includes(shift)) {
    throw new DailyBoardDraftPayloadError(`${label}.shift가 올바르지 않습니다.`);
  }
  return {
    date: String(o.date ?? ""),
    shift,
    sequenceIndex: asFiniteInt(o.sequenceIndex ?? 0, `${label}.sequenceIndex`),
    reason: String(o.reason ?? ""),
    reservation: parseReservation(o.reservation, `${label}.reservation`),
    caddy: parseCaddy(o.caddy, `${label}.caddy`),
    kind: kind as AutoAssignmentRow["kind"],
    ...(o.pairId !== undefined ? { pairId: o.pairId as string | null } : {}),
    ...(o.note !== undefined ? { note: o.note as string | null } : {}),
    ...(typeof o.locked === "boolean" ? { locked: o.locked } : {}),
  };
}

function parseSpare(raw: unknown, label: string): SpareByShift {
  const o = asRecord(raw, label);
  const shift = String(o.shift ?? "") as ShiftPart;
  if (!SHIFT_PARTS.includes(shift)) {
    throw new DailyBoardDraftPayloadError(`${label}.shift가 올바르지 않습니다.`);
  }
  const parseInfo = (v: unknown, inner: string) => {
    if (v == null) return null;
    const s = asRecord(v, inner);
    return {
      caddyId: asFiniteInt(s.caddyId, `${inner}.caddyId`),
      name: String(s.name ?? ""),
      team: String(s.team ?? ""),
      teamOrder: Number(s.teamOrder) || 0,
    };
  };
  return {
    shift,
    spare1: parseInfo(o.spare1, `${label}.spare1`),
    spare2: parseInfo(o.spare2, `${label}.spare2`),
  };
}

const UI_ONLY_KEYS = [
  "swapKey",
  "moveKey",
  "expandedKey",
  "quickSheet",
  "search",
  "scroll",
  "selectedPopup",
  "viewMode",
  "toast",
  "file",
  "dutyFile",
];

export function parseDailyBoardDraftPayload(
  raw: unknown,
  expectedDate: string
): DailyBoardDraftPayloadV1 {
  if (!isYmd(expectedDate)) {
    throw new DailyBoardDraftPayloadError("date는 YYYY-MM-DD 이어야 합니다.");
  }
  const o = asRecord(raw, "payload");
  for (const key of UI_ONLY_KEYS) {
    if (key in o) {
      throw new DailyBoardDraftPayloadError(
        `payload에 UI 임시 상태(${key})를 넣을 수 없습니다.`
      );
    }
  }
  const schemaVersion = asFiniteInt(
    o.schemaVersion ?? DAILY_BOARD_DRAFT_SCHEMA_VERSION,
    "schemaVersion"
  );
  if (schemaVersion !== DAILY_BOARD_DRAFT_SCHEMA_VERSION) {
    throw new DailyBoardDraftPayloadError(
      `지원하지 않는 schemaVersion입니다 (${schemaVersion}).`
    );
  }
  if (!isYmd(o.date) || o.date !== expectedDate) {
    throw new DailyBoardDraftPayloadError(
      "payload.date가 요청 날짜와 일치해야 합니다."
    );
  }
  const status = String(o.status ?? "DRAFT") as DraftStatus;
  if (!DRAFT_STATUSES.includes(status)) {
    throw new DailyBoardDraftPayloadError("status가 올바르지 않습니다.");
  }
  const openCourses = asArray(o.openCourses, "openCourses").map((c) => {
    const code = String(c);
    if (!(COURSE_CODES as readonly string[]).includes(code)) {
      throw new DailyBoardDraftPayloadError(`openCourses에 알 수 없는 코스: ${code}`);
    }
    return code as CourseCode;
  });
  const assignments = asArray(o.assignments, "assignments").map((row, i) =>
    parseAssignment(row, `assignments[${i}]`)
  );
  if (assignments.length > 2500) {
    throw new DailyBoardDraftPayloadError("assignments가 너무 많습니다.");
  }
  return {
    schemaVersion: DAILY_BOARD_DRAFT_SCHEMA_VERSION,
    date: expectedDate,
    status,
    assignments,
    unassignedReservations: asArray(
      o.unassignedReservations ?? [],
      "unassignedReservations"
    ).map((u, i) => parseUnassigned(u, `unassignedReservations[${i}]`)),
    closedCourseReservations: asArray(
      o.closedCourseReservations ?? [],
      "closedCourseReservations"
    ).map((u, i) => parseUnassigned(u, `closedCourseReservations[${i}]`)),
    openCourses,
    caddyPool: asArray(o.caddyPool ?? [], "caddyPool").map((c, i) =>
      parseCaddy(c, `caddyPool[${i}]`)
    ),
    sparesByShift: asArray(o.sparesByShift ?? [], "sparesByShift").map((s, i) =>
      parseSpare(s, `sparesByShift[${i}]`)
    ),
    confirmedAt:
      o.confirmedAt == null || o.confirmedAt === ""
        ? null
        : String(o.confirmedAt),
    appliedAt:
      o.appliedAt == null || o.appliedAt === "" ? null : String(o.appliedAt),
    applyAuditId:
      o.applyAuditId == null || o.applyAuditId === ""
        ? null
        : asFiniteInt(o.applyAuditId, "applyAuditId"),
  };
}

export function formatDraftSavedAt(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
