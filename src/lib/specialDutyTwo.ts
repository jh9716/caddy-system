/**
 * 특수근무 2부 단독(TWO): 지정 코스+티타임과 정확히 일치하는 2부 예약만 배치.
 * 가장 가까운 시간으로 대체하지 않는다. autoAssignEngine 고정/다른 특수 우선순위는 바꾸지 않는다.
 */

import type {
  AutoAssignCaddy,
  AutoAssignReservation,
  AutoAssignmentRow,
  SpecialUnassignedRow,
} from "@/lib/autoAssignEngine";
import { reservationKey } from "@/lib/reservationIdentity";
import {
  COURSE_CODES,
  COURSE_LABELS,
  normalizeCourse,
  parseTeeTime,
  type CourseCode,
} from "@/lib/reservationParser";

function courseCodeOf(raw: unknown): CourseCode | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if ((COURSE_CODES as readonly string[]).includes(upper)) {
    return upper as CourseCode;
  }
  return normalizeCourse(text);
}

export const TWO_ONLY_SHIFT = "2부" as const;

export type TwoOnlyCandidate = AutoAssignCaddy & {
  course: string;
  teeTime: string;
};

export function twoOnlyCandidatesFromRecords(
  rows: ReadonlyArray<
    AutoAssignCaddy & { specialCourse?: string | null; specialTeeTime?: string | null }
  >
): TwoOnlyCandidate[] {
  return rows.map((caddy) => ({
    ...caddy,
    course: String(caddy.specialCourse || ""),
    teeTime: String(caddy.specialTeeTime || ""),
  }));
}

export type TwoOnlySlot = {
  course: string;
  teeTime: string;
};

export const TWO_ONLY_REASON = {
  PRIORITY: "TWO_ONLY_PRIORITY",
  MISSING_RESERVATION: "TWO_ONLY_MISSING_RESERVATION",
  RESERVATION_CONFLICT: "TWO_ONLY_RESERVATION_CONFLICT",
  CADDY_CONFLICT: "TWO_ONLY_CADDY_CONFLICT",
  MISSING_SLOT: "TWO_ONLY_MISSING_SLOT",
} as const;

export function normalizeExactTeeTime(value: unknown): string | null {
  return parseTeeTime(value);
}

export function parseTwoOnlySlot(input: {
  course?: unknown;
  teeTime?: unknown;
}): { ok: true; course: CourseCode; teeTime: string } | { ok: false; message: string } {
  const course = courseCodeOf(input.course);
  const teeTime = normalizeExactTeeTime(input.teeTime);
  if (!course) {
    return { ok: false, message: "2부 단독은 코스를 지정해야 합니다." };
  }
  if (!teeTime) {
    return { ok: false, message: "2부 단독은 예약 시간(HH:MM)을 지정해야 합니다." };
  }
  return { ok: true, course, teeTime };
}

export function twoOnlySlotLabel(slot: TwoOnlySlot): string {
  const code = courseCodeOf(slot.course);
  const course = code ? COURSE_LABELS[code] : String(slot.course || "");
  const tee = normalizeExactTeeTime(slot.teeTime) || String(slot.teeTime || "");
  return `${course} ${TWO_ONLY_SHIFT} ${tee}`.trim();
}

/** 코스·부·티타임이 모두 같을 때만 true. 근접 시간 허용 없음. */
export function matchesExactShift2Reservation(
  reservation: AutoAssignReservation,
  slot: TwoOnlySlot
): boolean {
  if (String(reservation.shift) !== TWO_ONLY_SHIFT) return false;
  const wantCourse = courseCodeOf(slot.course);
  const gotCourse = courseCodeOf(reservation.course);
  if (!wantCourse || !gotCourse || wantCourse !== gotCourse) return false;
  const wantTee = normalizeExactTeeTime(slot.teeTime);
  const gotTee = normalizeExactTeeTime(reservation.teeTime);
  if (!wantTee || !gotTee) return false;
  return wantTee === gotTee;
}

export function findExactShift2Reservation(
  reservations: readonly AutoAssignReservation[],
  slot: TwoOnlySlot
): AutoAssignReservation | null {
  const hits = reservations.filter((row) =>
    matchesExactShift2Reservation(row, slot)
  );
  if (hits.length === 0) return null;
  return hits[0];
}

function occupiedCaddyIds(rows: readonly AutoAssignmentRow[]): Set<number> {
  const ids = new Set<number>();
  for (const row of rows) {
    if (Number.isInteger(row.caddy?.id) && row.caddy.id > 0) {
      ids.add(row.caddy.id);
    }
  }
  return ids;
}

/**
 * 2부 단독: remaining에서 지정 슬롯만 점유.
 * occupied(고정·마샬 등)와 겹치면 충돌. 없으면 미배치. 근접 대체 없음.
 */
export function assignTwoOnlyExactSlots(input: {
  date: string;
  candidates: readonly TwoOnlyCandidate[];
  remaining: readonly AutoAssignReservation[];
  occupiedReservations?: readonly AutoAssignmentRow[];
  assignedCaddyIds?: ReadonlySet<number>;
}): {
  assignments: AutoAssignmentRow[];
  specialUnassigned: SpecialUnassignedRow[];
  remainingReservations: AutoAssignReservation[];
  assignedCaddyIds: Set<number>;
} {
  const assignments: AutoAssignmentRow[] = [];
  const specialUnassigned: SpecialUnassignedRow[] = [];
  const assignedCaddyIds = new Set(input.assignedCaddyIds || []);
  const occupied = input.occupiedReservations || [];
  const occupiedCaddies = occupiedCaddyIds(occupied);
  let remaining = [...input.remaining];
  const seenCaddy = new Set<number>();

  for (const caddy of input.candidates) {
    const slotParsed = parseTwoOnlySlot(caddy);
    if (!slotParsed.ok) {
      specialUnassigned.push({
        caddy,
        reason: TWO_ONLY_REASON.MISSING_SLOT,
        review: true,
        note: slotParsed.message,
      });
      continue;
    }
    const slot = { course: slotParsed.course, teeTime: slotParsed.teeTime };
    const label = twoOnlySlotLabel(slot);

    if (
      seenCaddy.has(caddy.id) ||
      assignedCaddyIds.has(caddy.id) ||
      occupiedCaddies.has(caddy.id)
    ) {
      specialUnassigned.push({
        caddy,
        reason: TWO_ONLY_REASON.CADDY_CONFLICT,
        review: true,
        note: `동일 캐디 중복배치 충돌 (${label})`,
      });
      continue;
    }
    seenCaddy.add(caddy.id);

    const remainingHit = findExactShift2Reservation(remaining, slot);
    if (remainingHit) {
      const key = reservationKey(remainingHit);
      assignedCaddyIds.add(caddy.id);
      assignments.push({
        date: input.date,
        shift: TWO_ONLY_SHIFT,
        sequenceIndex: -1,
        reason: TWO_ONLY_REASON.PRIORITY,
        reservation: remainingHit,
        caddy,
        pairId: null,
        kind: "two",
        locked: true,
        note: label,
      });
      remaining = remaining.filter((row) => reservationKey(row) !== key);
      continue;
    }

    const occupiedHit = occupied.find((row) =>
      matchesExactShift2Reservation(row.reservation, slot)
    );
    if (occupiedHit) {
      specialUnassigned.push({
        caddy,
        reason: TWO_ONLY_REASON.RESERVATION_CONFLICT,
        review: true,
        note: `지정 예약이 다른 캐디에게 점유됨 (${label})`,
      });
      continue;
    }

    specialUnassigned.push({
      caddy,
      reason: TWO_ONLY_REASON.MISSING_RESERVATION,
      review: true,
      note: `지정한 2부 예약이 없습니다 (${label})`,
    });
  }

  return {
    assignments,
    specialUnassigned,
    remainingReservations: remaining,
    assignedCaddyIds,
  };
}
