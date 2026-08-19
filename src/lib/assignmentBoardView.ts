/**
 * /manage/assignments 배치표 표시용 순수 헬퍼 (엔진/confirm 무관)
 * - 부 분류는 teeTime 추정 금지
 * - reservation.shift(없으면 row.shift)만 사용
 * - 투/찾근은 표시 플래그만 — 우선순위 로직은 변경하지 않음
 */

import {
  REASON,
  resolveCourseCode,
  type AutoAssignmentRow,
} from "@/lib/autoAssignEngine";
import {
  COURSE_CODES,
  SHIFT_PARTS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export type BoardCell =
  | { kind: "closed" }
  | { kind: "empty" }
  | { kind: "assigned"; rows: AutoAssignmentRow[] };

export type BoardTimeRow = {
  teeTime: string;
  cells: Record<CourseCode, BoardCell>;
};

const SHIFT_RANK: Record<string, number> = Object.fromEntries(
  SHIFT_PARTS.map((shift, i) => [shift, i])
);

/** 표시·필터용 부: reservation.shift 우선 (시간 추정 없음) */
export function assignmentShiftOf(row: AutoAssignmentRow): string {
  const fromRes = row.reservation?.shift;
  if (fromRes != null && String(fromRes).trim() !== "") {
    return String(fromRes);
  }
  return String(row.shift || "");
}

function shiftRankOf(shift: string): number {
  if (shift in SHIFT_RANK) return SHIFT_RANK[shift];
  return 99;
}

/**
 * 같은 날짜에 이미 앞 부에서 근무한 뒤 다시 배치된 캐디 (투근무).
 * 특수 우선순위 로직은 변경하지 않고, 당일 실제 배치 결과만 본다.
 */
export function isTwoWorkAssignment(
  row: AutoAssignmentRow,
  allRows: readonly AutoAssignmentRow[]
): boolean {
  const rowRank = shiftRankOf(assignmentShiftOf(row));
  if (rowRank >= 99) return false;
  return allRows.some((other) => {
    if (other.caddy.id !== row.caddy.id) return false;
    return shiftRankOf(assignmentShiftOf(other)) < rowRank;
  });
}

/** 찾근(특별/마샬/당번 찾근) 배치. kind=fixed 이면서 찾근 reason일 때만. */
export function isChageunAssignment(row: AutoAssignmentRow): boolean {
  if (row.kind !== "fixed") return false;
  const blob = `${row.reason || ""} ${row.note || ""}`;
  return (
    blob.includes(REASON.SPECIAL_CALL) ||
    blob.includes(REASON.MARSHAL_CALL) ||
    blob.includes(REASON.DUTY_CALL) ||
    /찾근/.test(blob)
  );
}

export type BoardAssignmentMarks = {
  twoWork: boolean;
  chageun: boolean;
  limousine: boolean;
  driving: boolean;
};

export function boardAssignmentMarks(
  row: AutoAssignmentRow,
  allRows: readonly AutoAssignmentRow[]
): BoardAssignmentMarks {
  return {
    twoWork: isTwoWorkAssignment(row, allRows),
    chageun: isChageunAssignment(row),
    limousine: row.reservation?.limousineCart === true,
    driving: row.kind === "driving",
  };
}

/** 선택된 부로 완전 분리 — teeTime으로 추정/혼합하지 않음 */
export function filterAssignmentsByShift(
  rows: readonly AutoAssignmentRow[],
  shift: ShiftPart
): AutoAssignmentRow[] {
  return rows.filter((row) => assignmentShiftOf(row) === shift);
}

/**
 * 이미 한 부로 걸러진 rows로 teeTime × 코스 matrix 생성.
 * shift를 넘기면 방어적으로 해당 부가 아닌 행은 제외한다.
 */
export function buildShiftBoard(
  rows: readonly AutoAssignmentRow[],
  openCourses: readonly CourseCode[],
  shift?: ShiftPart
): BoardTimeRow[] {
  const scoped =
    shift != null ? filterAssignmentsByShift(rows, shift) : [...rows];
  const open = new Set(openCourses);
  const byTimeCourse = new Map<string, AutoAssignmentRow[]>();
  const times = new Set<string>();

  for (const row of scoped) {
    const code = resolveCourseCode(row.reservation.course);
    if (!code) continue;
    const tee = row.reservation.teeTime || "";
    times.add(tee);
    const key = `${tee}|${code}`;
    const list = byTimeCourse.get(key) || [];
    list.push(row);
    byTimeCourse.set(key, list);
  }

  return [...times].sort((a, b) => a.localeCompare(b)).map((teeTime) => {
    const cells = {} as Record<CourseCode, BoardCell>;
    for (const code of COURSE_CODES) {
      if (!open.has(code)) {
        cells[code] = { kind: "closed" };
        continue;
      }
      const list = byTimeCourse.get(`${teeTime}|${code}`) || [];
      cells[code] =
        list.length > 0 ? { kind: "assigned", rows: list } : { kind: "empty" };
    }
    return { teeTime, cells };
  });
}

/** matrix 안 assigned 셀에 들어 있는 assignment 개수 합 */
export function countBoardAssignments(board: readonly BoardTimeRow[]): number {
  let n = 0;
  for (const tr of board) {
    for (const code of COURSE_CODES) {
      const cell = tr.cells[code];
      if (cell.kind === "assigned") n += cell.rows.length;
    }
  }
  return n;
}
