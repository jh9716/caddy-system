/**
 * /manage/assignments 배치표 표시용 순수 헬퍼 (엔진/confirm 무관)
 * - 부 분류는 teeTime 추정 금지
 * - reservation.shift(없으면 row.shift)만 사용
 */

import { resolveCourseCode, type AutoAssignmentRow } from "@/lib/autoAssignEngine";
import {
  COURSE_CODES,
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

/** 표시·필터용 부: reservation.shift 우선 (시간 추정 없음) */
export function assignmentShiftOf(row: AutoAssignmentRow): string {
  const fromRes = row.reservation?.shift;
  if (fromRes != null && String(fromRes).trim() !== "") {
    return String(fromRes);
  }
  return String(row.shift || "");
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
