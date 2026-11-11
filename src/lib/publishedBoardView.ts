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
  shift: ShiftPart,
  options?: { fillInterior?: boolean }
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
    fillInterior: options?.fillInterior,
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

/**
 * 캐디 없는 자리(셀 편집 빈 칸 등). Published 스냅샷은 빈 이름을 "이름없음"으로, id 0/null 로 저장한다.
 */
export function isVacantPublishedPlacement(row: PublishedPlacementV1): boolean {
  return !(Number.isInteger(row.caddyId) && (row.caddyId as number) > 0);
}

export type PublishedCourseCount = {
  /** 배정 팀 수 = 캐디가 1명 이상 배정된 (티오프 시각) 칸 수. 2인 캐디 팀도 1팀. */
  teams: number;
  /** 배정 캐디 수 (빈 자리 제외). 2인 캐디 팀이 있으면 teams 보다 큼 */
  caddies: number;
  /** 예약 칸은 있으나 캐디가 없는 자리 (Published 에 남은 빈 캐디 칸만, 미배정 예약 목록은 Published 에 없음) */
  vacant: number;
};

/**
 * 코스별 집계. 역할별 응답(캐디는 reservationKey 없음)에 상관없이 같은 값이 나오도록
 * 팀 단위 = (부, 코스, 티오프 시각) 칸으로 센다. 한 칸 = 한 팀.
 */
export function countPublishedCourseTeams(
  board: readonly PublishedTimeRow[]
): Record<CourseCode, PublishedCourseCount> {
  const out = {} as Record<CourseCode, PublishedCourseCount>;
  for (const code of COURSE_CODES) {
    let teams = 0;
    let caddies = 0;
    let vacant = 0;
    for (const tr of board) {
      const cell = tr.cells[code];
      if (cell.kind !== "assigned") continue;
      const real = cell.placements.filter((p) => !isVacantPublishedPlacement(p)).length;
      caddies += real;
      if (real > 0) teams += 1;
      else vacant += 1;
    }
    out[code] = { teams, caddies, vacant };
  }
  return out;
}
