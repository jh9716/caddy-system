/**
 * 범용 예약팀 이동 (MOVE_RESERVATION) — 순수 헬퍼.
 * 캐디 placement를 복사하지 않고, 예약 위치만 바꾼 뒤 regular reflow에 맡긴다.
 */
import {
  isDrivingPlacement,
  isPlacementLocked,
  isWeekendBandRow,
  parseAssignShiftPart,
  reservationKey,
  resolveCourseCode,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignmentRow,
  type AutoAssignResultV1,
  type PlacementDiff,
  type ReservationChangeEvent,
} from "@/lib/autoAssignEngine";
import { reservationMatchesIdentity } from "@/lib/reservationIdentity";
import {
  COURSE_CODES,
  COURSE_LABELS,
  parseTeeTime,
  SHIFT_PARTS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export type ReservationMoveDest = {
  course: CourseCode;
  shift: ShiftPart;
  teeTime: string;
};

export type ReservationMoveSummary = {
  teamName: string | null;
  reservationKey: string;
  reservationId: string | number | null;
  from: { course: string; shift: string; teeTime: string };
  to: ReservationMoveDest;
  beforeCaddy: Pick<AutoAssignCaddy, "id" | "name" | "team"> | null;
  afterCaddy: Pick<AutoAssignCaddy, "id" | "name" | "team"> | null;
  freezeShifts: ShiftPart[];
  reflowShifts: ShiftPart[];
  placementChangeCount: number;
  sameCaddyBySequence: boolean;
  fullDayWarning: boolean;
  caddyFollowsTeam: boolean;
};

const SHIFT_RANK: Record<ShiftPart, number> = {
  "1부": 0,
  "2부": 1,
  "3부": 2,
};

export {
  isStableReservationMoveKey,
  stableReservationMoveKeyFromId,
} from "@/lib/reservationIdentity";

export function parseMoveDestination(to: {
  course?: unknown;
  shift?: unknown;
  teeTime?: unknown;
} | null | undefined): ReservationMoveDest | null {
  if (!to) return null;
  const course = resolveCourseCode(String(to.course ?? ""));
  const shift = parseAssignShiftPart(to.shift);
  const teeTime = parseTeeTime(to.teeTime);
  if (!course || !shift || !teeTime) return null;
  if (!(COURSE_CODES as readonly string[]).includes(course)) return null;
  return { course, shift, teeTime };
}

export function earliestShiftForMove(
  from: ShiftPart,
  to: ShiftPart
): ShiftPart {
  return SHIFT_RANK[from] <= SHIFT_RANK[to] ? from : to;
}

/** earliest보다 앞선 부만 freeze. earliest=1부 → []. */
export function freezeShiftsForMove(
  from: ShiftPart,
  to: ShiftPart
): ShiftPart[] {
  const earliest = earliestShiftForMove(from, to);
  return SHIFT_PARTS.filter((s) => SHIFT_RANK[s] < SHIFT_RANK[earliest]);
}

export function reflowShiftsForMove(
  from: ShiftPart,
  to: ShiftPart
): ShiftPart[] {
  const frozen = new Set(freezeShiftsForMove(from, to));
  return SHIFT_PARTS.filter((s) => !frozen.has(s));
}

export function sameReservationSlot(
  a: Pick<AutoAssignReservation, "course" | "shift" | "teeTime">,
  b: Pick<ReservationMoveDest, "course" | "shift" | "teeTime">
): boolean {
  return (
    resolveCourseCode(String(a.course)) === resolveCourseCode(String(b.course)) &&
    parseAssignShiftPart(a.shift) === parseAssignShiftPart(b.shift) &&
    String(a.teeTime) === String(b.teeTime)
  );
}

export function reservationMoveBlockReason(
  row: AutoAssignmentRow | null | undefined,
  opts?: {
    dest?: ReservationMoveDest | null;
    destDate?: string | null;
    openCourses?: readonly string[] | null;
    destOccupied?: boolean;
    sourceStatus?: string | null;
  }
): { code: string; message: string } | null {
  if (!row) {
    return {
      code: "MOVE_NOT_FOUND",
      message: "이동할 예약을 찾을 수 없습니다.",
    };
  }
  const status = String(opts?.sourceStatus || "").toUpperCase();
  if (status === "CANCELLED" || status === "TEAM_NOSHOW") {
    return {
      code: "MOVE_SOURCE_INACTIVE",
      message: "취소/노쇼 예약은 이동할 수 없습니다.",
    };
  }
  if (isDrivingPlacement(row) || row.kind === "driving") {
    return {
      code: "MOVE_DRIVING",
      message: "드라이빙 배치는 1차 팀 이동 대상이 아닙니다.",
    };
  }
  if (row.kind !== "regular" || isWeekendBandRow(row)) {
    return {
      code: "MOVE_SPECIAL",
      message: "특수 배치(LOCK/1·3/주말반 등)는 1차에서 이동할 수 없습니다.",
    };
  }
  if (isPlacementLocked(row) || row.locked === true) {
    return {
      code: "MOVE_LOCKED",
      message: "LOCK ON 예약은 잠금을 해제한 뒤에만 이동할 수 있습니다.",
    };
  }
  const dest = opts?.dest;
  if (!dest) return null;
  if (opts?.destDate && opts.destDate !== row.reservation.date) {
    return {
      code: "MOVE_DATE_CHANGE",
      message: "다른 날짜로는 이동할 수 없습니다.",
    };
  }
  if (sameReservationSlot(row.reservation, dest)) {
    return {
      code: "MOVE_SAME_SLOT",
      message: "목적지가 현재 위치와 같습니다.",
    };
  }
  const open = opts?.openCourses;
  if (open && open.length > 0) {
    const destCourse = resolveCourseCode(dest.course);
    const allowed = new Set(
      open.map((c) => String(resolveCourseCode(String(c)) || c).toUpperCase())
    );
    if (destCourse && !allowed.has(destCourse)) {
      return {
        code: "MOVE_CLOSED_COURSE",
        message: "닫힌 코스로는 이동할 수 없습니다.",
      };
    }
  }
  if (opts?.destOccupied) {
    return {
      code: "DUPLICATE_COURSE_TEETIME",
      message: "해당 코스/티타임에 이미 예약이 있습니다.",
    };
  }
  return null;
}

export function emptyBoardCellAction(
  moveReservationKey: string | null | undefined
): "move" | "add" {
  // MOVE_RESERVATION 활성 상태가 ADD_RESERVATION보다 우선.
  return String(moveReservationKey || "").trim() ? "move" : "add";
}

export const TEAM_MOVED_TOAST = "팀을 이동했습니다.";
export const TEAM_MOVING_LABEL = "이동 중...";

export function isPendingMoveDest(
  pending: { course: string; shift: string; teeTime: string } | null | undefined,
  cell: { course: string; shift: string; teeTime: string }
): boolean {
  if (!pending) return false;
  return (
    resolveCourseCode(String(pending.course)) ===
      resolveCourseCode(String(cell.course)) &&
    parseAssignShiftPart(pending.shift) === parseAssignShiftPart(cell.shift) &&
    String(pending.teeTime) === String(cell.teeTime)
  );
}

export function courseLabelKo(course: string): string {
  const code = resolveCourseCode(course);
  return (code && COURSE_LABELS[code]) || course;
}

export function caddyBrief(
  caddy: AutoAssignCaddy | null | undefined
): Pick<AutoAssignCaddy, "id" | "name" | "team"> | null {
  if (!caddy) return null;
  return { id: caddy.id, name: caddy.name, team: caddy.team };
}

export function countCaddyPlacementChanges(diffs: PlacementDiff[]): number {
  return diffs.filter(
    (d) => (d.beforeCaddy?.id ?? null) !== (d.afterCaddy?.id ?? null)
  ).length;
}

export function summarizeReservationMove(input: {
  before: AutoAssignResultV1;
  after: AutoAssignResultV1;
  event: Extract<ReservationChangeEvent, { type: "MOVE_RESERVATION" }>;
  warnings?: ReflowWarning[];
  placementDiffs?: PlacementDiff[];
}): ReservationMoveSummary | null {
  const dest = parseMoveDestination(input.event.to);
  if (!dest) return null;
  const key = input.event.reservationKey;
  const id = input.event.reservationId;
  const beforeRow =
    input.before.assignments.find((row) =>
      reservationMatchesIdentity(row.reservation, key, id)
    ) || null;
  const afterRow =
    input.after.assignments.find((row) =>
      reservationMatchesIdentity(row.reservation, key, id)
    ) || null;
  const from = beforeRow
    ? {
        course: String(beforeRow.reservation.course),
        shift: String(beforeRow.shift || beforeRow.reservation.shift),
        teeTime: beforeRow.reservation.teeTime,
      }
    : { course: "", shift: "", teeTime: "" };
  const fromShift = parseAssignShiftPart(from.shift) || dest.shift;
  const freezeShifts = freezeShiftsForMove(fromShift, dest.shift);
  const reflowShifts = reflowShiftsForMove(fromShift, dest.shift);
  const beforeCaddy = caddyBrief(beforeRow?.caddy);
  const afterCaddy = caddyBrief(afterRow?.caddy);
  return {
    teamName: beforeRow?.reservation.teamName ?? afterRow?.reservation.teamName ?? null,
    reservationKey: key || (beforeRow ? reservationKey(beforeRow.reservation) : ""),
    reservationId: id ?? beforeRow?.reservation.id ?? afterRow?.reservation.id ?? null,
    from,
    to: dest,
    beforeCaddy,
    afterCaddy,
    freezeShifts,
    reflowShifts,
    placementChangeCount: countCaddyPlacementChanges(
      input.placementDiffs || []
    ),
    sameCaddyBySequence:
      !!beforeCaddy && !!afterCaddy && beforeCaddy.id === afterCaddy.id,
    fullDayWarning: fromShift === "1부" || dest.shift === "1부",
    caddyFollowsTeam: false,
  };
}
