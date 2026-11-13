/**
 * 배치표 공통 시트 모델 (읽기 전용).
 * /board 화면 · 이미지(PNG) · A4 인쇄(PDF) · 엑셀(XLSX)이 모두 이 모델 하나로 같은 표를 그린다.
 *
 * 표 구조: 행 = 코스 안에서의 팀 순번(1..21), 열 = 코스마다 [시각 | 캐디 | 비고(빈 칸, 저장 없음)].
 *  - 코스별 실제 티오프 시각을 각 칸에 그대로 쓴다 (코스 간 시각을 맞추거나 만들지 않음).
 *  - 시각 출처: 운영 티시트(예약 엑셀의 실제 티 행) ∪ 예약(배정·미배치). 보간으로 만든 시각은 쓰지 않는다.
 *  - 기본 21행(코스별 최대 21팀 운영). 21을 넘으면 행을 늘리고 overflow 로 표시 (절대 자르지 않음).
 *  - 배정 = 캐디가 1명 이상 있는 팀. 미배치 = 예약 칸은 있으나 캐디 없음.
 *    한계: 게시본(Published)에는 미배정 예약 목록이 없다. 칸 자체가 없는 예약은 세지 못한다
 *    (assignmentDraftFromPublishedPayload 가 unassignedReservations 를 빈 배열로 둔다).
 *    /manage 초안 출력은 unassignedReservations 를 포함하므로 미배치가 잡힌다.
 * 자동배치/순번/LOCK/DB/API 와 무관. draft 를 읽기만 한다.
 */

import { assignmentsByShift, type AssignmentDraft } from "@/lib/assignmentDraft";
import { boardAssignmentMarks, buildShiftBoard } from "@/lib/assignmentBoardView";
import {
  BOARD_EXPORT_COURSE_LABELS,
  boardOpenCoursesFromDraft,
  redactGuestNameFromAssignment,
  spareLabelsFromShift,
  type BoardExportSpare,
} from "@/lib/assignmentBoardExport";
import type { AssignmentKind, AutoAssignmentRow } from "@/lib/autoAssignEngine";
import { caddyAffiliation } from "@/lib/caddyDisplay";
import { supportBoardBadgeLabels } from "@/lib/dailySpecialSupport";
import { COURSE_CODES, type CourseCode, type ShiftPart } from "@/lib/reservationParser";

/** 코스별 기준 팀 수 (= 기본 행 수). 1·2·3부 동일. */
export const BOARD_SHEET_BASE_ROWS = 21;
export const BOARD_SHEET_TITLE = "VERTHILL 배치표";
export const BOARD_SHEET_UNASSIGNED_LABEL = "미배치";
export const BOARD_SHEET_CLOSED_LABEL = "휴장";
export const BOARD_SHEET_NO_RESERVATION_LABEL = "예약 없음";
/** 코스마다 [시각 | 캐디 | 비고]. 비고는 빈 칸만 (저장 기능 없음). */
export const BOARD_SHEET_REMARK_LABEL = "비고";
export const BOARD_SHEET_COLS_PER_COURSE = 3;

const LINKED_KIND_TAG: Partial<Record<AssignmentKind, string>> = {
  oneTwo: "1·2",
  two: "2",
  twoThree: "2·3",
  oneThree: "1·3",
  fiftyFourHole: "54",
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** YYYY-MM-DD → 요일 (UTC 기준 계산이라 타임존 영향 없음) */
export function boardPrintWeekday(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAYS[d.getUTCDay()];
}

/** 셀 편집으로 생긴 빈 캐디 placeholder 등 실제 캐디가 아닌 배치 */
export function isVacantPrintCaddy(row: AutoAssignmentRow): boolean {
  const caddy = row.caddy;
  if (!caddy) return true;
  if (!Number.isInteger(caddy.id) || caddy.id <= 0) return true;
  return String(caddy.name || "").trim() === "";
}

/** 칸에 붙는 짧은 표시. 기존 화면/엑셀 배지 의미만 재사용, 새 규칙 없음. */
export function boardPrintMarks(
  row: AutoAssignmentRow,
  allAssignments: readonly AutoAssignmentRow[]
): string[] {
  const marks = boardAssignmentMarks(row, allAssignments);
  const out: string[] = [];
  if (marks.limousine) out.push("리무진");
  if (marks.houseRequest) out.push("하우스");
  if (marks.driving) out.push("드라이빙");
  if (marks.twoWork) out.push("투");
  if (marks.chageun) out.push("찾근");
  if (marks.specialSupport) {
    const badges = supportBoardBadgeLabels(
      row.supportKind || row.caddy?.supportKind,
      row.supportWorkPattern || row.caddy?.supportWorkPattern
    );
    if (badges.kind) out.push(badges.kind);
    if (badges.pattern) out.push(badges.pattern);
  } else {
    const linked = LINKED_KIND_TAG[row.kind];
    if (linked) out.push(linked);
  }
  return [...new Set(out.filter(Boolean))];
}

export type BoardSheetCaddy = {
  name: string;
  affiliation: string;
  marks: string[];
  /** 캐디 없는 자리 (셀 편집 빈 칸 등) → "미배치" */
  vacant: boolean;
  /** 투근무(기존 twoWork 판정). 이름 칸 노란 배경용. 판정 로직은 여기서 바꾸지 않음. */
  twoWork: boolean;
};

export type BoardSheetSlotState = "assigned" | "unassigned" | "empty";

export type BoardSheetSlot = {
  teeTime: string;
  /** assigned: 캐디 있음 / unassigned: 예약은 있으나 캐디 없음 / empty: 실제 운영 티지만 예약 없음 */
  state: BoardSheetSlotState;
  caddies: BoardSheetCaddy[];
  /** includeTeamName 일 때만 채워짐 */
  teamNames: string[];
};

export type BoardSheetCourse = {
  code: CourseCode;
  label: string;
  open: boolean;
  slots: BoardSheetSlot[];
  /** 예약 팀 수 (배정 + 미배치) */
  teams: number;
  assigned: number;
  unassigned: number;
  /** 행(슬롯) 수가 21 초과 */
  overflow: boolean;
};

export type BoardSheetModel = {
  date: string;
  weekday: string | null;
  shift: ShiftPart;
  includeTeamName: boolean;
  courses: BoardSheetCourse[];
  /** 표의 행 수 = max(21, 코스별 최대 슬롯 수) */
  rowCount: number;
  overflowCourses: CourseCode[];
  spare: BoardExportSpare;
  totals: { assigned: number; unassigned: number; teams: number };
  isEmpty: boolean;
};

export type BoardSheetOptions = {
  /** 예약자명 표시. 기본 false (기존 export 개인정보 정책) */
  includeTeamName?: boolean;
  /** LOCK 표시 (/board 화면 기존 표시 유지용). 기본 false */
  showLock?: boolean;
};

function caddyOf(
  row: AutoAssignmentRow,
  all: readonly AutoAssignmentRow[],
  showLock: boolean
): BoardSheetCaddy {
  if (isVacantPrintCaddy(row)) {
    return { name: "", affiliation: "", marks: [], vacant: true, twoWork: false };
  }
  const marks = boardPrintMarks(row, all);
  if (showLock && row.locked === true) marks.push("LOCK");
  return {
    name: String(row.caddy.name || "").trim(),
    affiliation: row.caddy ? caddyAffiliation(row.caddy) : "",
    marks,
    vacant: false,
    twoWork: marks.includes("투"),
  };
}

function uniqTeamNames(names: Array<string | null | undefined>): string[] {
  return [...new Set(names.map((n) => String(n ?? "").trim()).filter(Boolean))];
}

export function buildBoardSheetModel(
  draft: AssignmentDraft,
  shift: ShiftPart,
  opts?: BoardSheetOptions
): BoardSheetModel {
  const includeTeamName = opts?.includeTeamName === true;
  const showLock = opts?.showLock === true;
  const scrub = (row: AutoAssignmentRow) =>
    includeTeamName ? row : redactGuestNameFromAssignment(row);
  const openCourses = boardOpenCoursesFromDraft(draft);
  const open = new Set(openCourses);
  const shiftRows = assignmentsByShift(draft, shift).map(scrub);
  const unassigned = (draft.unassignedReservations || []).map((u) =>
    includeTeamName ? u : { ...u, reservation: { ...u.reservation, teamName: null } }
  );
  const allAssignments = (draft.assignments || []).map(scrub);
  // 기존 화면과 같은 부 분리·셀 판정을 재사용 (reservation.shift 우선, teeTime 추정 없음)
  const board = buildShiftBoard(shiftRows, openCourses, shift, {
    teeSheet: draft.teeSheet,
    unassignedReservations: unassigned,
  });
  // 실제 운영 티 (예약 엑셀의 티 행). 보간 시각은 여기에 없다.
  const realTee = new Set(
    (draft.teeSheet || [])
      .filter((s) => s.shift === shift)
      .map((s) => `${s.course}|${s.teeTime}`)
  );

  const courses: BoardSheetCourse[] = COURSE_CODES.map((code) => {
    const isOpen = open.has(code);
    const slots: BoardSheetSlot[] = [];
    if (isOpen) {
      for (const tr of board) {
        const cell = tr.cells[code];
        if (cell.kind === "assigned") {
          const caddies = cell.rows.map((r) => caddyOf(r, allAssignments, showLock));
          slots.push({
            teeTime: tr.teeTime,
            state: caddies.every((c) => c.vacant) ? "unassigned" : "assigned",
            caddies,
            teamNames: includeTeamName ? uniqTeamNames(cell.rows.map((r) => r.reservation.teamName)) : [],
          });
        } else if (cell.kind === "unassigned") {
          slots.push({
            teeTime: tr.teeTime,
            state: "unassigned",
            caddies: [],
            teamNames: includeTeamName ? uniqTeamNames([cell.reservation.teamName]) : [],
          });
        } else if (cell.kind === "empty" && realTee.has(`${code}|${tr.teeTime}`)) {
          slots.push({ teeTime: tr.teeTime, state: "empty", caddies: [], teamNames: [] });
        }
      }
    }
    const assigned = slots.filter((s) => s.state === "assigned").length;
    const vacant = slots.filter((s) => s.state === "unassigned").length;
    return {
      code,
      label: BOARD_EXPORT_COURSE_LABELS[code],
      open: isOpen,
      slots,
      teams: assigned + vacant,
      assigned,
      unassigned: vacant,
      overflow: slots.length > BOARD_SHEET_BASE_ROWS,
    };
  });
  const rowCount = Math.max(BOARD_SHEET_BASE_ROWS, ...courses.map((c) => c.slots.length));
  const totals = {
    assigned: courses.reduce((n, c) => n + c.assigned, 0),
    unassigned: courses.reduce((n, c) => n + c.unassigned, 0),
    teams: courses.reduce((n, c) => n + c.teams, 0),
  };
  return {
    date: draft.date,
    weekday: boardPrintWeekday(draft.date),
    shift,
    includeTeamName,
    courses,
    rowCount,
    overflowCourses: courses.filter((c) => c.overflow).map((c) => c.code),
    spare: spareLabelsFromShift(
      draft.sparesByShift?.find((row) => row.shift === shift) || null
    ),
    totals,
    isEmpty: courses.every((c) => c.slots.length === 0),
  };
}

/** 코스 헤더 아래 요약 문구 */
export function boardSheetCourseSummary(course: BoardSheetCourse): string {
  if (!course.open) return BOARD_SHEET_CLOSED_LABEL;
  if (course.teams === 0) return BOARD_SHEET_NO_RESERVATION_LABEL;
  const base = `배정 ${course.assigned}${course.unassigned ? ` · 미배치 ${course.unassigned}` : ""}`;
  return course.overflow ? `${base} · ${course.slots.length}행(21 초과)` : base;
}

/** 엑셀·텍스트용 캐디 칸 문자열: "이름 조 [표시·표시]" (여러 명은 줄바꿈) */
export function boardSheetSlotText(slot: BoardSheetSlot, includeTeamName = false): string {
  const lines: string[] = [];
  if (slot.state === "unassigned" && slot.caddies.length === 0) {
    lines.push(BOARD_SHEET_UNASSIGNED_LABEL);
  }
  for (const c of slot.caddies) {
    if (c.vacant) {
      lines.push(BOARD_SHEET_UNASSIGNED_LABEL);
      continue;
    }
    const base = [c.name, c.affiliation].filter(Boolean).join(" ");
    lines.push(c.marks.length ? `${base} [${c.marks.join("·")}]` : base);
  }
  if (includeTeamName && slot.teamNames.length) lines.push(slot.teamNames.join(", "));
  return lines.join("\n");
}

export function boardSheetDateLabel(model: Pick<BoardSheetModel, "date" | "weekday">): string {
  return model.weekday ? `${model.date} (${model.weekday})` : model.date;
}
