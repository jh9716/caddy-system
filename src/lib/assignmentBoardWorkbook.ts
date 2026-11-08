/**
 * 배치표 엑셀형 조작 헬퍼.
 * 기존 V3 직접편집(applyDirectCaddyEdit / overlayUnassignedVacancies)을 재사용한다.
 * 엔진 재계산·저장 형식은 바꾸지 않는다.
 */

import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { BoardTimeRow } from "@/lib/assignmentBoardView";
import { COURSE_CODES, type CourseCode } from "@/lib/reservationParser";

export const WORKBOOK_UNDO_LIMIT = 40;

export type WorkbookCellCoord = {
  teeTime: string;
  course: CourseCode;
};

export function cloneDraftSnapshot(draft: AssignmentDraft): AssignmentDraft {
  return {
    ...draft,
    assignments: draft.assignments.map((row) => ({
      ...row,
      reservation: { ...row.reservation },
      caddy: { ...row.caddy },
    })),
    unassignedReservations: draft.unassignedReservations.map((row) => ({
      ...row,
      reservation: { ...row.reservation },
    })),
    closedCourseReservations: (draft.closedCourseReservations || []).map(
      (row) => ({
        ...row,
        reservation: { ...row.reservation },
      })
    ),
    caddyPool: draft.caddyPool.map((caddy) => ({ ...caddy })),
    sparesByShift: (draft.sparesByShift || []).map((row) => ({
      ...row,
      spare1: row.spare1 ? { ...row.spare1 } : null,
      spare2: row.spare2 ? { ...row.spare2 } : null,
    })),
    unavailableCaddyIds: [...(draft.unavailableCaddyIds || [])],
    unavailableFromShift: (draft.unavailableFromShift || []).map((row) => ({
      ...row,
    })),
  };
}

export function pushWorkbookUndo<T>(
  stack: readonly T[],
  snapshot: T,
  limit = WORKBOOK_UNDO_LIMIT
): T[] {
  return [...stack, snapshot].slice(-Math.max(1, limit));
}

export function undoWorkbookState<T>(input: {
  undo: readonly T[];
  redo: readonly T[];
  current: T;
}): { current: T; undo: T[]; redo: T[] } | null {
  if (!input.undo.length) return null;
  const prev = input.undo[input.undo.length - 1];
  return {
    current: prev,
    undo: input.undo.slice(0, -1),
    redo: [...input.redo, input.current],
  };
}

export function redoWorkbookState<T>(input: {
  undo: readonly T[];
  redo: readonly T[];
  current: T;
}): { current: T; undo: T[]; redo: T[] } | null {
  if (!input.redo.length) return null;
  const next = input.redo[input.redo.length - 1];
  return {
    current: next,
    undo: [...input.undo, input.current],
    redo: input.redo.slice(0, -1),
  };
}

export function listWorkbookCellCoords(
  board: readonly BoardTimeRow[],
  openCourses: readonly CourseCode[] = COURSE_CODES
): WorkbookCellCoord[] {
  const open = openCourses.length ? openCourses : COURSE_CODES;
  const out: WorkbookCellCoord[] = [];
  for (const row of board) {
    for (const course of open) {
      const cell = row.cells[course];
      if (!cell || cell.kind === "closed") continue;
      out.push({ teeTime: row.teeTime, course });
    }
  }
  return out;
}

export function sameWorkbookCell(
  a: WorkbookCellCoord | null | undefined,
  b: WorkbookCellCoord | null | undefined
): boolean {
  if (!a || !b) return false;
  return a.teeTime === b.teeTime && a.course === b.course;
}

export function neighborWorkbookCell(
  coords: readonly WorkbookCellCoord[],
  current: WorkbookCellCoord | null,
  delta: { dRow?: number; dCol?: number }
): WorkbookCellCoord | null {
  if (!coords.length) return null;
  if (!current) return coords[0];
  const times = [...new Set(coords.map((c) => c.teeTime))];
  const courses = [...new Set(coords.map((c) => c.course))];
  let row = times.indexOf(current.teeTime);
  let col = courses.indexOf(current.course);
  if (row < 0) row = 0;
  if (col < 0) col = 0;
  row = Math.max(0, Math.min(times.length - 1, row + (delta.dRow || 0)));
  col = Math.max(0, Math.min(courses.length - 1, col + (delta.dCol || 0)));
  const next = { teeTime: times[row], course: courses[col] };
  return coords.find((c) => sameWorkbookCell(c, next)) || next;
}

export function workbookCellKey(coord: WorkbookCellCoord): string {
  return `${coord.teeTime}|${coord.course}`;
}
