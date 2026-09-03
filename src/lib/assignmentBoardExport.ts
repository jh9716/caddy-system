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
import type { DailyBoardPublishedPayloadV1 } from "@/lib/dailyBoardPublished";
import {
  COURSE_CODES,
  COURSE_LABELS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export const BOARD_EXPORT_SHIFTS: ShiftPart[] = ["1부", "2부", "3부"];

/** 720px export 헤더용 코스명. 베/스/오/레 단축은 쓰지 않는다. */
export const BOARD_EXPORT_COURSE_LABELS: Record<CourseCode, string> = {
  ...COURSE_LABELS,
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

/**
 * 최종 배치표(/board) payload → export가 재사용하는 draft shape.
 * Published/Draft write 없음. 화면의 최신 payload만 읽는다.
 */
export function assignmentDraftFromPublishedPayload(
  payload: DailyBoardPublishedPayloadV1
): AssignmentDraft {
  const assignments: AutoAssignmentRow[] = payload.placements.map((p, i) => {
    const kind = p.chageun ? "fixed" : p.driving ? "driving" : p.kind;
    return {
      date: payload.date,
      shift: p.shift,
      sequenceIndex: p.sequenceIndex,
      reason: p.chageun ? "찾근" : p.specialSupport ? "SPECIAL_SUPPORT" : "PUBLISHED",
      kind,
      locked: p.locked,
      pairId: null,
      reservation: {
        id: p.reservationId ?? p.reservationKey ?? `pub-${i}`,
        date: payload.date,
        course: p.course,
        shift: p.shift,
        teeTime: p.teeTime,
        teamName: null, // /board export source redaction. 화면 payload는 그대로.
        rawRowIndex: i + 1,
        limousineCart: p.limousine === true,
      },
      caddy: {
        id: Number.isInteger(p.caddyId) ? (p.caddyId as number) : -(i + 1),
        name: p.caddyName,
        team: p.caddyTeam,
        teamOrder: 0,
      },
    };
  });
  const sparesByShift: SpareByShift[] = payload.sparesByShift.map((s) => ({
    shift: s.shift,
    spare1: s.spare1
      ? {
          caddyId: s.spare1.caddyId,
          name: s.spare1.name,
          team: s.spare1.team,
          teamOrder: 0,
        }
      : null,
    spare2: s.spare2
      ? {
          caddyId: s.spare2.caddyId,
          name: s.spare2.name,
          team: s.spare2.team,
          teamOrder: 0,
        }
      : null,
  }));
  return {
    date: payload.date,
    status: "CONFIRMED",
    assignments,
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: [...payload.openCourses],
    caddyPool: [],
    sparesByShift,
    confirmedAt: null,
  };
}

/** PNG/export 전용. 원본 Draft/Published payload는 바꾸지 않는다. */
export function redactGuestNameFromAssignment(
  row: AutoAssignmentRow
): AutoAssignmentRow {
  if (row.reservation.teamName == null) return row;
  return {
    ...row,
    reservation: { ...row.reservation, teamName: null },
  };
}

/** /manage/assignments 와 /board 가 넘긴 최신 board state (고객명 redaction 포함) */
export function buildBoardExportSlice(
  draft: AssignmentDraft,
  shift: ShiftPart
): BoardExportSlice {
  const openCourses = boardOpenCoursesFromDraft(draft);
  const shiftRows = assignmentsByShift(draft, shift).map(
    redactGuestNameFromAssignment
  );
  return {
    date: draft.date,
    shift,
    openCourses,
    rows: buildShiftBoard(shiftRows, openCourses, shift),
    spare: spareLabelsFromShift(
      draft.sparesByShift?.find((row) => row.shift === shift) || null
    ),
    allAssignments: draft.assignments.map(redactGuestNameFromAssignment),
  };
}

export function boardExportPngFilename(date: string, shift: ShiftPart): string {
  return `VERTHILL_배치표_${date}_${shift}.png`;
}
