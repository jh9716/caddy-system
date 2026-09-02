/**
 * 배치표 PNG export용 순수 데이터 (엔진/Draft write 없음)
 * 화면과 같은 draft + buildShiftBoard 를 재사용한다.
 */

import {
  assignmentsByShift,
  type AssignmentDraft,
} from "@/lib/assignmentDraft";
import {
  buildShiftBoard,
  type BoardTimeRow,
} from "@/lib/assignmentBoardView";
import type { AutoAssignmentRow } from "@/lib/autoAssignEngine";
import type { SpareByShift } from "@/lib/autoAssignEngine";
import { formatCaddyLabel } from "@/lib/caddyDisplay";
import { COURSE_CODES, type CourseCode, type ShiftPart } from "@/lib/reservationParser";

export const BOARD_EXPORT_SHIFTS: ShiftPart[] = ["1부", "2부", "3부"];

export const BOARD_EXPORT_COURSE_SHORT: Record<CourseCode, string> = {
  VERTHILL: "베",
  SKY: "스",
  OCEAN: "오",
  LAKE: "레",
};

export type BoardExportSpare = {
  spare1Label: string | null;
  spare2Label: string | null;
};

export type BoardExportSlice = {
  date: string;
  shift: ShiftPart;
  openCourses: CourseCode[];
  rows: BoardTimeRow[];
  spare: BoardExportSpare;
  allAssignments: AutoAssignmentRow[];
};

export function boardOpenCoursesFromDraft(draft: AssignmentDraft): CourseCode[] {
  if (!draft.openCourses) return [...COURSE_CODES];
  const open = new Set(draft.openCourses);
  return COURSE_CODES.filter((code) => open.has(code));
}

export function spareLabelsFromShift(spare: SpareByShift | null | undefined): BoardExportSpare {
  return {
    spare1Label: spare?.spare1 ? formatCaddyLabel(spare.spare1) : null,
    spare2Label: spare?.spare2 ? formatCaddyLabel(spare.spare2) : null,
  };
}

/** /manage/assignments 배치표와 동일한 draft source */
export function buildBoardExportSlice(
  draft: AssignmentDraft,
  shift: ShiftPart
): BoardExportSlice {
  const openCourses = boardOpenCoursesFromDraft(draft);
  const shiftRows = assignmentsByShift(draft, shift);
  return {
    date: draft.date,
    shift,
    openCourses,
    rows: buildShiftBoard(shiftRows, openCourses, shift),
    spare: spareLabelsFromShift(
      draft.sparesByShift?.find((row) => row.shift === shift) || null
    ),
    allAssignments: draft.assignments,
  };
}

export function boardExportPngFilename(date: string, shift: ShiftPart): string {
  return `VERTHILL_배치표_${date}_${shift}.png`;
}
