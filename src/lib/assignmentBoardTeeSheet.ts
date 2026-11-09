/**
 * 배치표 표시용 코스별 티타임 축.
 * 자동배치 엔진/순번/LOCK/예약 데이터는 바꾸지 않는다.
 */

import { resolveCourseCode } from "@/lib/autoAssignEngine";
import {
  COURSE_CODES,
  SHIFT_PARTS,
  dedupeCourseTeeSlots,
  teeTimeToMinutes,
  type CourseCode,
  type CourseTeeSlot,
  type ShiftPart,
} from "@/lib/reservationParser";

/** 예약 없는 칸 표시. 화면·이미지·엑셀 모두 빈 문자열. kind empty는 유지. */
export const BOARD_EMPTY_CELL_MARK = "";
/** 예약은 있으나 캐디 미배정 */
export const BOARD_UNASSIGNED_CELL_LABEL = "미배치";

/** 부 내부 연속 티 간격 상한. 이보다 큰 gap은 밴드 공백으로 보고 채우지 않는다. */
const INTRA_BAND_GAP_MAX_MINUTES = 45;

export function minutesToTeeTime(total: number): string | null {
  if (!Number.isInteger(total) || total < 0 || total >= 24 * 60) return null;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function cloneCourseTeeSheet(
  slots?: readonly CourseTeeSlot[] | null
): CourseTeeSlot[] | undefined {
  if (!slots?.length) return undefined;
  return dedupeCourseTeeSlots(slots);
}

export function isBoardTeeTime(value: string): boolean {
  return /^\d{2}:\d{2}$/.test(value);
}

/**
 * 코스·부 관측 간격. 전역 7분 격자 금지.
 * 작은 gap의 최소값이 나머지 배수이면 그 값을 쓴다 (7,14,7 → 7).
 */
export function inferCourseTeeIntervalMinutes(
  times: readonly string[]
): number | null {
  const mins = [
    ...new Set(
      times
        .map((t) => teeTimeToMinutes(t))
        .filter((n): n is number => n != null)
    ),
  ].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 0; i < mins.length - 1; i++) {
    const gap = mins[i + 1] - mins[i];
    if (gap > 0 && gap <= INTRA_BAND_GAP_MAX_MINUTES) gaps.push(gap);
  }
  if (!gaps.length) return null;
  const min = Math.min(...gaps);
  const multiples = gaps.filter((gap) => gap % min === 0);
  if (multiples.length * 2 >= gaps.length) return min;
  const counts = new Map<number, number>();
  for (const gap of gaps) counts.set(gap, (counts.get(gap) || 0) + 1);
  let best = min;
  let bestN = 0;
  for (const [gap, n] of counts) {
    if (n > bestN || (n === bestN && gap < best)) {
      best = gap;
      bestN = n;
    }
  }
  return best;
}

/** min~max 사이만, 관측 간격의 배수 gap만 채운다. 앞뒤 연장 없음. */
export function fillInteriorTeeTimes(times: readonly string[]): string[] {
  const original = [...new Set(times.map((t) => String(t || "").trim()).filter(Boolean))];
  const uniq = original.filter(isBoardTeeTime).sort((a, b) => a.localeCompare(b));
  const interval = inferCourseTeeIntervalMinutes(uniq);
  const filled: string[] = [...original];
  if (!interval || uniq.length < 2) {
    return [...new Set(filled)].sort((a, b) => a.localeCompare(b));
  }
  for (let i = 0; i < uniq.length; i++) {
    if (i === uniq.length - 1) break;
    const start = teeTimeToMinutes(uniq[i]);
    const end = teeTimeToMinutes(uniq[i + 1]);
    if (start == null || end == null) continue;
    const gap = end - start;
    if (gap <= interval || gap > INTRA_BAND_GAP_MAX_MINUTES) continue;
    if (gap % interval !== 0) continue;
    for (let t = start + interval; t < end; t += interval) {
      const formatted = minutesToTeeTime(t);
      if (formatted) filled.push(formatted);
    }
  }
  return [...new Set(filled)].sort((a, b) => a.localeCompare(b));
}

export type TeeTimeSourceReservation = {
  course?: string | null;
  shift?: string | null;
  teeTime?: string | null;
};

export function teeSlotsFromReservations(
  reservations: readonly TeeTimeSourceReservation[]
): CourseTeeSlot[] {
  const out: CourseTeeSlot[] = [];
  for (const row of reservations) {
    const course = resolveCourseCode(String(row.course || ""));
    const shift = String(row.shift || "") as ShiftPart;
    const teeTime = String(row.teeTime || "");
    if (!course || !SHIFT_PARTS.includes(shift) || !teeTime.trim()) {
      continue;
    }
    out.push({ course, shift, teeTime });
  }
  return dedupeCourseTeeSlots(out);
}

export function collectShiftBoardTeeTimes(input: {
  shift: ShiftPart;
  teeSheet?: readonly CourseTeeSlot[] | null;
  reservations?: readonly TeeTimeSourceReservation[] | null;
}): string[] {
  const fromSheet = (input.teeSheet || []).filter(
    (slot) => slot.shift === input.shift && isBoardTeeTime(slot.teeTime)
  );
  const fromRes = teeSlotsFromReservations(input.reservations || []).filter(
    (slot) => slot.shift === input.shift
  );
  const byCourse = new Map<CourseCode, Set<string>>();
  for (const code of COURSE_CODES) byCourse.set(code, new Set());
  for (const slot of [...fromSheet, ...fromRes]) {
    byCourse.get(slot.course)?.add(slot.teeTime);
  }
  const union = new Set<string>();
  for (const times of byCourse.values()) {
    // 티시트가 있어도 관측 간격의 내부 공석만 채운다. 전역 7분 격자/앞뒤 연장은 하지 않는다.
    for (const time of fillInteriorTeeTimes([...times])) union.add(time);
  }
  return [...union].sort((a, b) => a.localeCompare(b));
}
