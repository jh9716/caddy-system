/**
 * 날짜별 최종 Published 배치표 payload.
 * Draft 전체 React state가 아니라 공용 배치표 렌더링용 canonical snapshot.
 * Caddy rename/retire 이후에도 표시가 유지되도록 이름/조/라벨을 저장한다.
 */

import {
  boardAssignmentMarks,
} from "@/lib/assignmentBoardView";
import type { AssignmentKind, AutoAssignmentRow } from "@/lib/autoAssignEngine";
import { reservationKey, resolveCourseCode } from "@/lib/autoAssignEngine";
import { caddyAffiliation, formatCaddyLabel } from "@/lib/caddyDisplay";
import {
  DailyBoardDraftPayloadError,
  isYmd,
  type DailyBoardDraftPayloadV1,
} from "@/lib/dailyBoardDraft";
import {
  COURSE_CODES,
  SHIFT_PARTS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export const DAILY_BOARD_PUBLISHED_SCHEMA_VERSION = 1 as const;

export const PUBLISH_STALE_DRAFT = "PUBLISH_STALE_DRAFT";
export const PUBLISH_STALE_DRAFT_MESSAGE =
  "다른 직원이 이 작업본을 수정했습니다. 최신 작업본을 다시 불러온 뒤 확정해 주세요.";
export const PUBLISH_NO_DRAFT = "PUBLISH_NO_DRAFT";
export const PUBLISH_NO_DRAFT_MESSAGE = "확정할 작업본이 없습니다.";
export const PUBLISH_SUCCESS_MESSAGE = "배치가 확정되었습니다.";
export const PUBLISH_ALREADY_CURRENT_MESSAGE =
  "현재 작업본이 이미 확정되어 있습니다";

const ASSIGNMENT_KINDS: AssignmentKind[] = [
  "regular",
  "fiftyFourHole",
  "oneThree",
  "oneTwo",
  "oneMak",
  "fixed",
  "driving",
  "specialSupport",
];

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
  "caddyPool",
  "unassignedReservations",
  "closedCourseReservations",
  "status",
  "confirmedAt",
  "appliedAt",
  "applyAuditId",
  "assignments",
];

export type PublishedPlacementV1 = {
  shift: ShiftPart;
  course: string;
  teeTime: string;
  teamName: string | null;
  reservationId: string | number | null;
  reservationKey: string;
  caddyId: number | null;
  caddyName: string;
  caddyTeam: string;
  displayLabel: string;
  kind: AssignmentKind;
  locked: boolean;
  limousine: boolean;
  houseRequest?: boolean;
  driving: boolean;
  twoWork: boolean;
  chageun: boolean;
  specialSupport: boolean;
  sequenceIndex: number;
};

export type PublishedSpareCaddyV1 = {
  caddyId: number;
  name: string;
  team: string;
  displayLabel: string;
};

export type PublishedSpareV1 = {
  shift: ShiftPart;
  spare1: PublishedSpareCaddyV1 | null;
  spare2: PublishedSpareCaddyV1 | null;
};

export type DailyBoardPublishedPayloadV1 = {
  schemaVersion: typeof DAILY_BOARD_PUBLISHED_SCHEMA_VERSION;
  date: string;
  openCourses: CourseCode[];
  placements: PublishedPlacementV1[];
  sparesByShift: PublishedSpareV1[];
  publisherUsername: string | null;
};

export class DailyBoardPublishedPayloadError extends Error {
  status = 400;
  code = "PUBLISHED_PAYLOAD_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "DailyBoardPublishedPayloadError";
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DailyBoardPublishedPayloadError(`${label} 객체가 필요합니다.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DailyBoardPublishedPayloadError(`${label} 배열이 필요합니다.`);
  }
  return value;
}

function asFiniteInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new DailyBoardPublishedPayloadError(`${label} 정수가 필요합니다.`);
  }
  return n;
}

function asShift(value: unknown, label: string): ShiftPart {
  const shift = String(value ?? "") as ShiftPart;
  if (!(SHIFT_PARTS as readonly string[]).includes(shift)) {
    throw new DailyBoardPublishedPayloadError(`${label}이 올바르지 않습니다.`);
  }
  return shift;
}

function asKind(value: unknown, label: string): AssignmentKind {
  const kind = String(value ?? "regular") as AssignmentKind;
  if (!ASSIGNMENT_KINDS.includes(kind)) {
    throw new DailyBoardPublishedPayloadError(`${label}이 올바르지 않습니다.`);
  }
  return kind;
}

function parseSpareCaddy(
  raw: unknown,
  label: string
): PublishedSpareCaddyV1 | null {
  if (raw == null) return null;
  const o = asRecord(raw, label);
  const name = String(o.name ?? "").trim();
  const team = String(o.team ?? "").trim();
  if (!name) {
    throw new DailyBoardPublishedPayloadError(`${label}.name이 필요합니다.`);
  }
  const displayLabel =
    String(o.displayLabel ?? "").trim() ||
    formatCaddyLabel({ name, team });
  return {
    caddyId: asFiniteInt(o.caddyId, `${label}.caddyId`),
    name,
    team,
    displayLabel,
  };
}

function parsePlacement(raw: unknown, label: string): PublishedPlacementV1 {
  const o = asRecord(raw, label);
  const caddyName = String(o.caddyName ?? "").trim();
  if (!caddyName) {
    throw new DailyBoardPublishedPayloadError(`${label}.caddyName이 필요합니다.`);
  }
  const caddyTeam = String(o.caddyTeam ?? "");
  const displayLabel =
    String(o.displayLabel ?? "").trim() ||
    formatCaddyLabel({ name: caddyName, team: caddyTeam });
  const reservationId =
    o.reservationId == null || o.reservationId === ""
      ? null
      : (o.reservationId as string | number);
  const caddyIdRaw = o.caddyId;
  const caddyId =
    caddyIdRaw == null || caddyIdRaw === ""
      ? null
      : asFiniteInt(caddyIdRaw, `${label}.caddyId`);
  return {
    shift: asShift(o.shift, `${label}.shift`),
    course: String(o.course ?? "").trim(),
    teeTime: String(o.teeTime ?? ""),
    teamName: o.teamName == null || o.teamName === "" ? null : String(o.teamName),
    reservationId,
    reservationKey: String(o.reservationKey ?? ""),
    caddyId,
    caddyName,
    caddyTeam,
    displayLabel,
    kind: asKind(o.kind, `${label}.kind`),
    locked: o.locked === true,
    limousine: o.limousine === true,
    houseRequest: o.houseRequest === true,
    driving: o.driving === true || String(o.kind) === "driving",
    twoWork: o.twoWork === true,
    chageun: o.chageun === true,
    specialSupport:
      o.specialSupport === true || String(o.kind) === "specialSupport",
    sequenceIndex: asFiniteInt(o.sequenceIndex ?? 0, `${label}.sequenceIndex`),
  };
}

export function parseDailyBoardPublishedPayload(
  raw: unknown,
  expectedDate: string
): DailyBoardPublishedPayloadV1 {
  if (!isYmd(expectedDate)) {
    throw new DailyBoardPublishedPayloadError("date는 YYYY-MM-DD 이어야 합니다.");
  }
  const o = asRecord(raw, "payload");
  for (const key of UI_ONLY_KEYS) {
    if (key in o) {
      throw new DailyBoardPublishedPayloadError(
        `payload에 Draft/UI 필드(${key})를 넣을 수 없습니다.`
      );
    }
  }
  const schemaVersion = asFiniteInt(
    o.schemaVersion ?? DAILY_BOARD_PUBLISHED_SCHEMA_VERSION,
    "schemaVersion"
  );
  if (schemaVersion !== DAILY_BOARD_PUBLISHED_SCHEMA_VERSION) {
    throw new DailyBoardPublishedPayloadError(
      `지원하지 않는 schemaVersion입니다 (${schemaVersion}).`
    );
  }
  if (!isYmd(o.date) || o.date !== expectedDate) {
    throw new DailyBoardPublishedPayloadError(
      "payload.date가 요청 날짜와 일치해야 합니다."
    );
  }
  const openCourses = asArray(o.openCourses, "openCourses").map((c) => {
    const code = String(c);
    if (!(COURSE_CODES as readonly string[]).includes(code)) {
      throw new DailyBoardPublishedPayloadError(
        `openCourses에 알 수 없는 코스: ${code}`
      );
    }
    return code as CourseCode;
  });
  const placements = asArray(o.placements, "placements").map((row, i) =>
    parsePlacement(row, `placements[${i}]`)
  );
  if (placements.length > 2500) {
    throw new DailyBoardPublishedPayloadError("placements가 너무 많습니다.");
  }
  const sparesByShift = asArray(o.sparesByShift ?? [], "sparesByShift").map(
    (s, i) => {
      const rec = asRecord(s, `sparesByShift[${i}]`);
      return {
        shift: asShift(rec.shift, `sparesByShift[${i}].shift`),
        spare1: parseSpareCaddy(rec.spare1, `sparesByShift[${i}].spare1`),
        spare2: parseSpareCaddy(rec.spare2, `sparesByShift[${i}].spare2`),
      };
    }
  );
  return {
    schemaVersion: DAILY_BOARD_PUBLISHED_SCHEMA_VERSION,
    date: expectedDate,
    openCourses,
    placements,
    sparesByShift,
    publisherUsername:
      o.publisherUsername == null || o.publisherUsername === ""
        ? null
        : String(o.publisherUsername),
  };
}

function placementFromAssignment(
  row: AutoAssignmentRow,
  allRows: readonly AutoAssignmentRow[]
): PublishedPlacementV1 {
  const marks = boardAssignmentMarks(row, allRows);
  const course =
    resolveCourseCode(row.reservation.course) || String(row.reservation.course || "");
  const caddyName = String(row.caddy?.name ?? "").trim() || "이름없음";
  const caddyTeam = caddyAffiliation(row.caddy || {});
  const reservationId =
    row.reservation?.id == null || row.reservation.id === ""
      ? null
      : row.reservation.id;
  return {
    shift: (row.reservation?.shift || row.shift) as ShiftPart,
    course,
    teeTime: String(row.reservation?.teeTime ?? ""),
    teamName:
      row.reservation?.teamName == null || row.reservation.teamName === ""
        ? null
        : String(row.reservation.teamName),
    reservationId,
    reservationKey: reservationKey(row.reservation),
    caddyId: Number.isInteger(row.caddy?.id) ? row.caddy.id : null,
    caddyName,
    caddyTeam,
    displayLabel: formatCaddyLabel({
      name: caddyName,
      team: row.caddy?.team,
      caddyType: row.caddy?.caddyType,
    }),
    kind: row.kind,
    locked: row.locked === true,
    limousine: marks.limousine,
    houseRequest: marks.houseRequest,
    driving: marks.driving,
    twoWork: marks.twoWork,
    chageun: marks.chageun,
    specialSupport: marks.specialSupport,
    sequenceIndex: Number.isInteger(row.sequenceIndex) ? row.sequenceIndex : 0,
  };
}

function spareFromDraft(
  info: { caddyId: number; name: string; team: string } | null
): PublishedSpareCaddyV1 | null {
  if (!info) return null;
  const name = String(info.name ?? "").trim() || "이름없음";
  const team = String(info.team ?? "");
  return {
    caddyId: info.caddyId,
    name,
    team,
    displayLabel: formatCaddyLabel({ name, team }),
  };
}

/** 서버 Draft payload → 공개 배치표 snapshot. 클라이언트 board JSON을 쓰지 않는다. */
export function buildPublishedPayloadFromDraft(
  draft: DailyBoardDraftPayloadV1,
  opts?: { publisherUsername?: string | null }
): DailyBoardPublishedPayloadV1 {
  if (!isYmd(draft.date)) {
    throw new DailyBoardDraftPayloadError("draft.date는 YYYY-MM-DD 이어야 합니다.");
  }
  const assignments = draft.assignments || [];
  const placements = assignments.map((row) =>
    placementFromAssignment(row, assignments)
  );
  const sparesByShift = (draft.sparesByShift || []).map((s) => ({
    shift: s.shift,
    spare1: spareFromDraft(s.spare1),
    spare2: spareFromDraft(s.spare2),
  }));
  return parseDailyBoardPublishedPayload(
    {
      schemaVersion: DAILY_BOARD_PUBLISHED_SCHEMA_VERSION,
      date: draft.date,
      openCourses: [...(draft.openCourses || [])],
      placements,
      sparesByShift,
      publisherUsername: opts?.publisherUsername ?? null,
    },
    draft.date
  );
}

export function formatPublishedAt(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function publisherDisplayName(
  username: string | null | undefined
): string {
  const name = String(username ?? "").trim();
  return name || "관리자";
}

export function todayYmd(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDaysYmd(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return todayYmd(d);
}
