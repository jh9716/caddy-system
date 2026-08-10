/**
 * 기본 캐디 자동배치 엔진 v1 + 54홀 우선 (자동배치 3·4단계)
 * - 순수 함수: DB write 없음
 * - 일반 available 순번 포인터/wrap 유지
 * - fiftyFourHole 후보를 먼저 배치한 뒤 남은 예약을 일반 순번으로 채움
 */

import { PRIMARY_TEAMS } from "@/lib/caddyManage";
import { SHIFT_PARTS, type ShiftPart } from "@/lib/reservationParser";

/** 54홀 연속 티업 최소 간격 (분) */
export const MIN_54HOLE_GAP_MINUTES = 6 * 60;

export const REASON = {
  REGULAR_SEQUENCE: "REGULAR_SEQUENCE",
  FIFTY_FOUR_HOLE_PRIORITY: "54HOLE_PRIORITY",
  FIFTY_FOUR_NO_PAIR: "54HOLE_NO_COMPATIBLE_PAIR",
  FIFTY_FOUR_INSUFFICIENT_RESERVATIONS: "54HOLE_INSUFFICIENT_RESERVATIONS",
  FIFTY_FOUR_TIME_OVERLAP: "54HOLE_TIME_OVERLAP",
} as const;

export type AutoAssignCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  caddyType?: string;
  extraFlags?: string[] | null;
};

export type AutoAssignReservation = {
  date: string;
  course: string;
  courseLabel?: string;
  shift: ShiftPart | string;
  teeTime: string;
  teamName: string | null;
  hole?: number | null;
  startingHole?: number | null;
  sourceSheet?: string;
  rawRowIndex?: number;
  needsReview?: boolean;
  isDuplicate?: boolean;
  reviewReasons?: string[];
};

export type AutoAssignmentRow = {
  date: string;
  shift: ShiftPart;
  sequenceIndex: number;
  reason: string;
  reservation: AutoAssignReservation;
  caddy: AutoAssignCaddy;
  /** 54홀 페어면 동일 pairId 공유 */
  pairId?: string | null;
  kind: "regular" | "fiftyFourHole";
};

export type UnassignedReservationRow = {
  reservation: AutoAssignReservation;
  reason: string;
};

export type SpecialUnassignedRow = {
  caddy: AutoAssignCaddy;
  reason: string;
  review: true;
};

export type AutoAssignResultV1 = {
  date: string;
  /** 전체 배치 (54홀 + 일반) */
  assignments: AutoAssignmentRow[];
  /** 54홀 우선 배치분만 */
  fiftyFourHoleAssignments: AutoAssignmentRow[];
  /** 일반 순번 배치분만 */
  regularAssignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  unusedCaddies: AutoAssignCaddy[];
  /** v1에서 자동 배치하지 않음 — fiftyFourHole 제외 후 전달 */
  special: AutoAssignCaddy[];
  /** 54홀 배치 실패 → 일반 강등 없이 review */
  specialUnassigned: SpecialUnassignedRow[];
  meta: {
    availableCount: number;
    reservationCount: number;
    assignedCount: number;
    unassignedCount: number;
    unusedCount: number;
    specialCount: number;
    fiftyFourHoleCandidateCount: number;
    fiftyFourHoleAssignedCaddyCount: number;
    fiftyFourHoleUnassignedCount: number;
    byShift: Record<
      ShiftPart,
      { reservations: number; assigned: number; unassigned: number }
    >;
    finalPointer: number;
  };
};

function teamRank(team: string): number {
  const idx = (PRIMARY_TEAMS as readonly string[]).indexOf(team);
  if (idx >= 0) return idx;
  return PRIMARY_TEAMS.length + 100;
}

export function compareCaddyOrder(a: AutoAssignCaddy, b: AutoAssignCaddy): number {
  const tr = teamRank(a.team) - teamRank(b.team);
  if (tr !== 0) return tr;
  if (a.team !== b.team) return a.team.localeCompare(b.team, "ko");
  if (a.teamOrder !== b.teamOrder) return a.teamOrder - b.teamOrder;
  return a.id - b.id;
}

function shiftRank(shift: string): number {
  const idx = (SHIFT_PARTS as readonly string[]).indexOf(shift);
  return idx >= 0 ? idx : 99;
}

export function compareReservationOrder(
  a: AutoAssignReservation,
  b: AutoAssignReservation
): number {
  const sr = shiftRank(String(a.shift)) - shiftRank(String(b.shift));
  if (sr !== 0) return sr;
  if (a.teeTime !== b.teeTime) return a.teeTime.localeCompare(b.teeTime);
  if (a.course !== b.course) return a.course.localeCompare(b.course);
  const ra = a.rawRowIndex ?? 0;
  const rb = b.rawRowIndex ?? 0;
  if (ra !== rb) return ra - rb;
  return String(a.teamName || "").localeCompare(String(b.teamName || ""), "ko");
}

function emptyShiftMeta(): Record<
  ShiftPart,
  { reservations: number; assigned: number; unassigned: number }
> {
  return {
    "1부": { reservations: 0, assigned: 0, unassigned: 0 },
    "2부": { reservations: 0, assigned: 0, unassigned: 0 },
    "3부": { reservations: 0, assigned: 0, unassigned: 0 },
  };
}

function dedupeCaddies(caddies: AutoAssignCaddy[]): AutoAssignCaddy[] {
  const seen = new Set<number>();
  const out: AutoAssignCaddy[] = [];
  for (const c of caddies) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function isAssignableReservation(
  r: AutoAssignReservation,
  date: string
): { ok: true } | { ok: false; reason: string } {
  if (r.date && r.date !== date) {
    return { ok: false, reason: `날짜 불일치(${r.date})` };
  }
  if (r.needsReview) {
    return {
      ok: false,
      reason: `needsReview(${(r.reviewReasons || []).join(",") || "검토필요"})`,
    };
  }
  if (r.isDuplicate) {
    return { ok: false, reason: "중복 티타임" };
  }
  if (!SHIFT_PARTS.includes(r.shift as ShiftPart)) {
    return { ok: false, reason: `부 판별 실패(${r.shift || ""})` };
  }
  if (!r.teeTime || !/^\d{2}:\d{2}$/.test(r.teeTime)) {
    return { ok: false, reason: "티타임 없음/형식오류" };
  }
  return { ok: true };
}

/** HH:mm → 당일 분 */
export function teeTimeToMinutes(teeTime: string): number {
  const m = teeTime.match(/^(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** date + teeTime → 비교용 epoch minutes (로컬 일자 기준) */
export function reservationInstantMinutes(r: Pick<AutoAssignReservation, "date" | "teeTime">): number {
  const [y, mo, d] = r.date.split("-").map(Number);
  const tee = teeTimeToMinutes(r.teeTime);
  if (!Number.isFinite(tee)) return NaN;
  return Math.floor(Date.UTC(y, mo - 1, d) / 60000) + tee;
}

export function minutesBetweenReservations(
  a: Pick<AutoAssignReservation, "date" | "teeTime">,
  b: Pick<AutoAssignReservation, "date" | "teeTime">
): number {
  return Math.abs(reservationInstantMinutes(b) - reservationInstantMinutes(a));
}

/** 두 티타임이 54홀 연속 배치 가능한지 (최소 간격) */
export function isCompatible54HolePair(
  a: Pick<AutoAssignReservation, "date" | "teeTime" | "shift">,
  b: Pick<AutoAssignReservation, "date" | "teeTime" | "shift">,
  minGapMinutes: number = MIN_54HOLE_GAP_MINUTES
): boolean {
  if (a.date !== b.date) return false;
  if (a.teeTime === b.teeTime) return false;
  const gap = minutesBetweenReservations(a, b);
  return Number.isFinite(gap) && gap >= minGapMinutes;
}

export type FiftyFourHolePair = {
  first: AutoAssignReservation;
  second: AutoAssignReservation;
  gapMinutes: number;
};

/**
 * 남은 예약에서 시간순 첫 번째 유효 54홀 페어를 찾는다.
 * (이른 티업 + 최소 6시간 이후 다음 티업)
 */
export function findEarliest54HolePair(
  reservations: AutoAssignReservation[],
  minGapMinutes: number = MIN_54HOLE_GAP_MINUTES
): FiftyFourHolePair | null {
  if (reservations.length < 2) return null;
  const sorted = [...reservations].sort((a, b) => {
    const da = reservationInstantMinutes(a) - reservationInstantMinutes(b);
    if (da !== 0) return da;
    return compareReservationOrder(a, b);
  });

  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i];
    const t1 = reservationInstantMinutes(first);
    if (!Number.isFinite(t1)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const second = sorted[j];
      const t2 = reservationInstantMinutes(second);
      if (!Number.isFinite(t2)) continue;
      const gap = t2 - t1;
      if (gap >= minGapMinutes) {
        return { first, second, gapMinutes: gap };
      }
    }
  }
  return null;
}

function reservationKey(r: AutoAssignReservation): string {
  return [
    r.date,
    r.course,
    r.shift,
    r.teeTime,
    r.rawRowIndex ?? "",
    r.teamName ?? "",
    r.sourceSheet ?? "",
  ].join("|");
}

/**
 * 54홀 후보를 우선 배치.
 * 실패 시 일반 순번으로 강등하지 않고 specialUnassigned(review)로 남긴다.
 */
export function assignFiftyFourHolePriority(input: {
  date: string;
  reservations: AutoAssignReservation[];
  fiftyFourHole: AutoAssignCaddy[];
  minGapMinutes?: number;
}): {
  assignments: AutoAssignmentRow[];
  specialUnassigned: SpecialUnassignedRow[];
  remainingReservations: AutoAssignReservation[];
  assignedCaddyIds: Set<number>;
} {
  const minGap = input.minGapMinutes ?? MIN_54HOLE_GAP_MINUTES;
  const candidates = dedupeCaddies([...input.fiftyFourHole]).sort(compareCaddyOrder);
  let remaining = [...input.reservations];
  const assignments: AutoAssignmentRow[] = [];
  const specialUnassigned: SpecialUnassignedRow[] = [];
  const assignedCaddyIds = new Set<number>();

  for (const caddy of candidates) {
    if (remaining.length < 2) {
      specialUnassigned.push({
        caddy,
        reason: REASON.FIFTY_FOUR_INSUFFICIENT_RESERVATIONS,
        review: true,
      });
      continue;
    }

    const pair = findEarliest54HolePair(remaining, minGap);
    if (!pair) {
      specialUnassigned.push({
        caddy,
        reason: REASON.FIFTY_FOUR_NO_PAIR,
        review: true,
      });
      continue;
    }

    // 안전: 겹침/간격 재검증
    if (!isCompatible54HolePair(pair.first, pair.second, minGap)) {
      specialUnassigned.push({
        caddy,
        reason: REASON.FIFTY_FOUR_TIME_OVERLAP,
        review: true,
      });
      continue;
    }

    const pairId = `54H-${caddy.id}-${pair.first.teeTime}-${pair.second.teeTime}`;
    const slots = [pair.first, pair.second].sort(compareReservationOrder);

    for (const reservation of slots) {
      assignments.push({
        date: input.date,
        shift: reservation.shift as ShiftPart,
        sequenceIndex: -1, // 일반 순번 포인터와 무관
        reason: REASON.FIFTY_FOUR_HOLE_PRIORITY,
        reservation,
        caddy,
        pairId,
        kind: "fiftyFourHole",
      });
    }

    assignedCaddyIds.add(caddy.id);
    const taken = new Set(slots.map(reservationKey));
    remaining = remaining.filter((r) => !taken.has(reservationKey(r)));
  }

  return {
    assignments,
    specialUnassigned,
    remainingReservations: remaining,
    assignedCaddyIds,
  };
}

/**
 * v1 자동배치 (+ 선택적 54홀 우선):
 * - 예약: 1부→2부→3부, 같은 부 안 teeTime 오름차순
 * - 54홀 후보 먼저 배치 (6시간 간격 페어), 실패 시 specialUnassigned
 * - 남은 예약은 일반 available 순번 포인터로 배치 (포인터는 일반 소비만 반영)
 * - special(비-54홀)은 배치하지 않고 별도 포함
 */
export function computeAutoAssignmentsV1(input: {
  date: string;
  reservations: AutoAssignReservation[];
  available: AutoAssignCaddy[];
  special?: AutoAssignCaddy[];
  /** 54홀 신청/지정 후보 — 명시적 입력 */
  fiftyFourHole?: AutoAssignCaddy[];
  min54HoleGapMinutes?: number;
}): AutoAssignResultV1 {
  const date = input.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const fiftyFourHole = dedupeCaddies([...(input.fiftyFourHole || [])]).sort(
    compareCaddyOrder
  );
  const fiftyFourIds = new Set(fiftyFourHole.map((c) => c.id));

  const special = dedupeCaddies([...(input.special || [])])
    .filter((c) => !fiftyFourIds.has(c.id))
    .sort(compareCaddyOrder);

  // 일반 순번 풀에서 54홀 후보 제외 (포인터 꼬임 방지)
  const available = dedupeCaddies([...(input.available || [])])
    .filter((c) => !fiftyFourIds.has(c.id))
    .sort(compareCaddyOrder);

  const unassignedReservations: UnassignedReservationRow[] = [];
  const byShift = emptyShiftMeta();

  const dayReservations = (input.reservations || []).map((r) =>
    r.date ? r : { ...r, date }
  );

  const eligible: AutoAssignReservation[] = [];
  for (const r of dayReservations) {
    if (r.date && r.date !== date) continue;
    const check = isAssignableReservation(r, date);
    if (!check.ok) {
      unassignedReservations.push({ reservation: r, reason: check.reason });
      continue;
    }
    eligible.push(r);
  }

  eligible.sort(compareReservationOrder);
  for (const shift of SHIFT_PARTS) {
    byShift[shift].reservations = eligible.filter((r) => r.shift === shift).length;
  }

  // 1) 54홀 우선
  const fiftyFour = assignFiftyFourHolePriority({
    date,
    reservations: eligible,
    fiftyFourHole,
    minGapMinutes: input.min54HoleGapMinutes,
  });

  const fiftyFourHoleAssignments = fiftyFour.assignments;
  const specialUnassigned = fiftyFour.specialUnassigned;
  const remainingEligible = fiftyFour.remainingReservations.sort(
    compareReservationOrder
  );

  // 2) 일반 순번 (포인터는 여기서만 전진)
  const regularAssignments: AutoAssignmentRow[] = [];
  const usedCaddyIds = new Set<number>(fiftyFour.assignedCaddyIds);
  let pointer = 0;

  for (const shift of SHIFT_PARTS) {
    const shiftReservations = remainingEligible.filter((r) => r.shift === shift);
    const usedInShift = new Set<number>();

    for (const reservation of shiftReservations) {
      if (available.length === 0) {
        unassignedReservations.push({
          reservation,
          reason: "가용 캐디 없음",
        });
        byShift[shift].unassigned += 1;
        continue;
      }

      let picked: AutoAssignCaddy | null = null;
      let pickedIndex = -1;
      for (let attempt = 0; attempt < available.length; attempt++) {
        const idx = (pointer + attempt) % available.length;
        const caddy = available[idx];
        if (usedInShift.has(caddy.id)) continue;
        picked = caddy;
        pickedIndex = idx;
        pointer = (idx + 1) % available.length;
        break;
      }

      if (!picked || pickedIndex < 0) {
        unassignedReservations.push({
          reservation,
          reason: `같은 부 중복 방지로 배치 불가(가용 ${available.length}명)`,
        });
        byShift[shift].unassigned += 1;
        continue;
      }

      usedInShift.add(picked.id);
      usedCaddyIds.add(picked.id);
      regularAssignments.push({
        date,
        shift,
        sequenceIndex: pickedIndex,
        reason: `${REASON.REGULAR_SEQUENCE}(${shift}, seq=${pickedIndex})`,
        reservation,
        caddy: picked,
        pairId: null,
        kind: "regular",
      });
      byShift[shift].assigned += 1;
    }
  }

  // 54홀 배치분도 byShift.assigned에 반영
  for (const a of fiftyFourHoleAssignments) {
    byShift[a.shift].assigned += 1;
  }

  const assignments = [...fiftyFourHoleAssignments, ...regularAssignments].sort(
    (a, b) => {
      const sr = shiftRank(a.shift) - shiftRank(b.shift);
      if (sr !== 0) return sr;
      return a.reservation.teeTime.localeCompare(b.reservation.teeTime);
    }
  );

  const unusedCaddies = available.filter((c) => !usedCaddyIds.has(c.id));
  const fiftyFourHoleAssignedCaddyCount = new Set(
    fiftyFourHoleAssignments.map((a) => a.caddy.id)
  ).size;

  return {
    date,
    assignments,
    fiftyFourHoleAssignments,
    regularAssignments,
    unassignedReservations,
    unusedCaddies,
    special,
    specialUnassigned,
    meta: {
      availableCount: available.length,
      reservationCount: eligible.length,
      assignedCount: assignments.length,
      unassignedCount: unassignedReservations.length,
      unusedCount: unusedCaddies.length,
      specialCount: special.length,
      fiftyFourHoleCandidateCount: fiftyFourHole.length,
      fiftyFourHoleAssignedCaddyCount,
      fiftyFourHoleUnassignedCount: specialUnassigned.length,
      byShift,
      finalPointer: available.length === 0 ? 0 : pointer,
    },
  };
}
