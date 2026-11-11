/**
 * 배치표 A4 인쇄용 순수 데이터 (읽기 전용).
 * - 화면이 들고 있는 draft를 읽기만 한다. 자동배치/순번/Draft·Published write 없음.
 * - 부 분리는 buildShiftBoard 와 같은 규칙(reservation.shift 우선, teeTime 추정 금지).
 * - 고객명(teamName)은 기존 PNG/Excel export 정책과 같이 기본 제외. 관리자가 켤 때만 표시.
 */

import { assignmentsByShift, type AssignmentDraft } from "@/lib/assignmentDraft";
import {
  boardAssignmentMarks,
  buildShiftBoard,
  type BoardTimeRow,
} from "@/lib/assignmentBoardView";
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
import {
  COURSE_CODES,
  SHIFT_PARTS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export const BOARD_PRINT_SHIFTS: readonly ShiftPart[] = SHIFT_PARTS;
export const BOARD_PRINT_TITLE = "VERTHILL 배치표";
/** 예약은 있으나 캐디가 없는 칸 (화면/엑셀의 미배치와 같은 의미) */
export const BOARD_PRINT_UNASSIGNED_LABEL = "미배치";
export const BOARD_PRINT_CLOSED_LABEL = "휴장";
export const BOARD_PRINT_EMPTY_COURSE_LABEL = "이 부 예약 없음";

const LINKED_KIND_TAG: Partial<Record<AssignmentKind, string>> = {
  oneTwo: "1·2",
  two: "2",
  twoThree: "2·3",
  oneThree: "1·3",
  fiftyFourHole: "54",
};

export type BoardPrintCourseSummary = {
  code: CourseCode;
  label: string;
  open: boolean;
  /** 캐디가 배정된 팀 수 */
  assigned: number;
  /** 예약은 있으나 캐디 없음 */
  unassigned: number;
};

export type BoardPrintSheet = {
  date: string;
  weekday: string | null;
  shift: ShiftPart;
  includeTeamName: boolean;
  openCourses: CourseCode[];
  courses: BoardPrintCourseSummary[];
  rows: BoardTimeRow[];
  spare: BoardExportSpare;
  /** 투근무 표시 판정용 (당일 전체). 다른 부 데이터는 행에 섞이지 않는다. */
  allAssignments: AutoAssignmentRow[];
  totals: { assigned: number; unassigned: number; teeTimes: number };
};

export function isBoardPrintShift(value: unknown): value is ShiftPart {
  return typeof value === "string" && (SHIFT_PARTS as readonly string[]).includes(value);
}

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

/** 인쇄 칸에 붙는 짧은 표시. 기존 화면/엑셀 배지 의미만 재사용, 새 규칙 없음. */
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

export function boardPrintCaddyAffiliation(row: AutoAssignmentRow): string {
  return row.caddy ? caddyAffiliation(row.caddy) : "";
}

export function buildBoardPrintSheet(
  draft: AssignmentDraft,
  shift: ShiftPart,
  opts?: { includeTeamName?: boolean }
): BoardPrintSheet {
  const includeTeamName = opts?.includeTeamName === true;
  const scrub = (row: AutoAssignmentRow) =>
    includeTeamName ? row : redactGuestNameFromAssignment(row);
  const openCourses = boardOpenCoursesFromDraft(draft);
  const shiftRows = assignmentsByShift(draft, shift).map(scrub);
  const unassigned = (draft.unassignedReservations || []).map((u) =>
    includeTeamName
      ? u
      : { ...u, reservation: { ...u.reservation, teamName: null } }
  );
  const rows = buildShiftBoard(shiftRows, openCourses, shift, {
    teeSheet: draft.teeSheet,
    unassignedReservations: unassigned,
  });
  const open = new Set(openCourses);
  const courses: BoardPrintCourseSummary[] = COURSE_CODES.map((code) => {
    let assigned = 0;
    let vacant = 0;
    for (const tr of rows) {
      const cell = tr.cells[code];
      if (cell.kind === "unassigned") vacant += 1;
      if (cell.kind === "assigned") {
        const real = cell.rows.filter((r) => !isVacantPrintCaddy(r));
        if (real.length > 0) assigned += 1;
        else vacant += 1;
      }
    }
    return {
      code,
      label: BOARD_EXPORT_COURSE_LABELS[code],
      open: open.has(code),
      assigned,
      unassigned: vacant,
    };
  });
  return {
    date: draft.date,
    weekday: boardPrintWeekday(draft.date),
    shift,
    includeTeamName,
    openCourses,
    courses,
    rows,
    spare: spareLabelsFromShift(
      draft.sparesByShift?.find((row) => row.shift === shift) || null
    ),
    allAssignments: (draft.assignments || []).map(scrub),
    totals: {
      assigned: courses.reduce((n, c) => n + c.assigned, 0),
      unassigned: courses.reduce((n, c) => n + c.unassigned, 0),
      teeTimes: rows.length,
    },
  };
}

export function boardPrintDocumentTitle(sheet: Pick<BoardPrintSheet, "date" | "shift">): string {
  return `VERTHILL_배치표_${sheet.date}_${sheet.shift}`;
}
