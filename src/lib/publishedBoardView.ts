/**
 * Published 배치표 표시용 순수 헬퍼.
 * /manage/assignments board matrix와 같은 teeTime×코스 규칙.
 */

import type {
  DailyBoardPublishedPayloadV1,
  PublishedPlacementV1,
} from "@/lib/dailyBoardPublished";
import { collectShiftBoardTeeTimes } from "@/lib/assignmentBoardTeeSheet";
import {
  COURSE_CODES,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";
import { resolveCourseCode } from "@/lib/autoAssignEngine";

export type PublishedBoardCell =
  | { kind: "closed" }
  | { kind: "empty" }
  | { kind: "assigned"; placements: PublishedPlacementV1[] };

export type PublishedTimeRow = {
  teeTime: string;
  cells: Record<CourseCode, PublishedBoardCell>;
};

export function filterPlacementsByShift(
  placements: readonly PublishedPlacementV1[],
  shift: ShiftPart
): PublishedPlacementV1[] {
  return placements.filter((row) => row.shift === shift);
}

export function buildPublishedShiftBoard(
  payload: Pick<
    DailyBoardPublishedPayloadV1,
    "placements" | "openCourses" | "teeSheet"
  >,
  shift: ShiftPart
): PublishedTimeRow[] {
  const scoped = filterPlacementsByShift(payload.placements, shift);
  const open = new Set(payload.openCourses);
  const byTimeCourse = new Map<string, PublishedPlacementV1[]>();

  for (const row of scoped) {
    const code = resolveCourseCode(row.course);
    if (!code) continue;
    const tee = row.teeTime || "";
    const key = `${tee}|${code}`;
    const list = byTimeCourse.get(key) || [];
    list.push(row);
    byTimeCourse.set(key, list);
  }

  const times = collectShiftBoardTeeTimes({
    shift,
    teeSheet: payload.teeSheet,
    reservations: scoped.map((row) => ({
      course: row.course,
      shift: row.shift,
      teeTime: row.teeTime,
    })),
  });

  return times.map((teeTime) => {
    const cells = {} as Record<CourseCode, PublishedBoardCell>;
    for (const code of COURSE_CODES) {
      if (!open.has(code)) {
        cells[code] = { kind: "closed" };
        continue;
      }
      const list = byTimeCourse.get(`${teeTime}|${code}`) || [];
      cells[code] =
        list.length > 0
          ? { kind: "assigned", placements: list }
          : { kind: "empty" };
    }
    return { teeTime, cells };
  });
}

export function countPublishedBoardPlacements(
  board: readonly PublishedTimeRow[]
): number {
  let n = 0;
  for (const tr of board) {
    for (const code of COURSE_CODES) {
      const cell = tr.cells[code];
      if (cell.kind === "assigned") n += cell.placements.length;
    }
  }
  return n;
}
