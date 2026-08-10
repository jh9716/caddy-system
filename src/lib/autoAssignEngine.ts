/**
 * 자동배치 엔진 (3~7단계)
 * - 순수 함수: DB write 없음
 * - 우선순위: 고정/특별찾근 → 54홀 → 1·3부 → 1·2부 → 일반 순번
 * - 일반 순번 포인터/wrap는 special 배치와 분리
 */

import { PRIMARY_TEAMS } from "@/lib/caddyManage";
import { SHIFT_PARTS, type ShiftPart } from "@/lib/reservationParser";

/** 54홀 연속 티업 최소 간격 (분) */
export const MIN_54HOLE_GAP_MINUTES = 6 * 60;

/** 1·3부 신청자 1부↔3부 최소 간격 (분) — 기본은 54홀과 동일, 독립 상수 */
export const MIN_ONE_THREE_GAP_MINUTES = 6 * 60;

/** 1·2부 신청자 1부↔2부 최소 간격 (분) — 기본 4시간, 현장 조정용 독립 상수 */
export const MIN_ONE_TWO_GAP_MINUTES = 4 * 60;

/** 동일 캐디 고정배치 간 최소 간격(분) — 미달이면 TIME_OVERLAP conflict */
export const MIN_FIXED_GAP_MINUTES = 0;

export const REASON = {
  REGULAR_SEQUENCE: "REGULAR_SEQUENCE",
  FIFTY_FOUR_HOLE_PRIORITY: "54HOLE_PRIORITY",
  FIFTY_FOUR_NO_PAIR: "54HOLE_NO_COMPATIBLE_PAIR",
  FIFTY_FOUR_INSUFFICIENT_RESERVATIONS: "54HOLE_INSUFFICIENT_RESERVATIONS",
  FIFTY_FOUR_TIME_OVERLAP: "54HOLE_TIME_OVERLAP",
  ONE_THREE_PRIORITY: "ONE_THREE_PRIORITY",
  ONE_THREE_NO_PAIR: "ONE_THREE_NO_COMPATIBLE_PAIR",
  ONE_THREE_MISSING_SHIFT1: "ONE_THREE_MISSING_SHIFT1",
  ONE_THREE_MISSING_SHIFT3: "ONE_THREE_MISSING_SHIFT3",
  ONE_THREE_INSUFFICIENT_RESERVATIONS: "ONE_THREE_INSUFFICIENT_RESERVATIONS",
  ONE_TWO_PRIORITY: "ONE_TWO_PRIORITY",
  ONE_TWO_NO_PAIR: "ONE_TWO_NO_COMPATIBLE_PAIR",
  ONE_TWO_MISSING_SHIFT1: "ONE_TWO_MISSING_SHIFT1",
  ONE_TWO_MISSING_SHIFT2: "ONE_TWO_MISSING_SHIFT2",
  ONE_TWO_INSUFFICIENT_RESERVATIONS: "ONE_TWO_INSUFFICIENT_RESERVATIONS",
  FIXED_ASSIGNMENT: "FIXED_ASSIGNMENT",
  MARSHAL_CALL: "MARSHAL_CALL",
  DUTY_CALL: "DUTY_CALL",
  SPECIAL_CALL: "SPECIAL_CALL",
  FIXED_UNKNOWN_CADDY: "FIXED_UNKNOWN_CADDY",
  FIXED_UNKNOWN_RESERVATION: "FIXED_UNKNOWN_RESERVATION",
  FIXED_CADDY_CONFLICT: "FIXED_CADDY_CONFLICT",
  FIXED_RESERVATION_CONFLICT: "FIXED_RESERVATION_CONFLICT",
  FIXED_TIME_OVERLAP: "FIXED_TIME_OVERLAP",
  FIXED_CANCELLED: "FIXED_CANCELLED",
} as const;

export type FixedAssignmentType =
  | "FIXED"
  | "FIXED_ASSIGNMENT"
  | "MARSHAL_CALL"
  | "DUTY_CALL"
  | "SPECIAL_CALL"
  | string;

/** 고정배치 / 특별찾근 입력 */
export type FixedAssignmentInput = {
  caddyId: number;
  /** 예약 식별자 (AutoAssignReservation.id 또는 identity key) */
  reservationId?: string | number;
  /** reservationId 없을 때 필드 매칭 */
  reservationMatch?: Partial<
    Pick<
      AutoAssignReservation,
      | "date"
      | "course"
      | "shift"
      | "teeTime"
      | "teamName"
      | "rawRowIndex"
      | "sourceSheet"
      | "id"
    >
  >;
  type: FixedAssignmentType;
  note?: string | null;
  /**
   * 찾근/고정 예약 캔슬 — 배치하지 않고 캐디·예약을 이후 단계에서 제외
   * (일반 순번으로 재투입하지 않음)
   */
  cancelled?: boolean;
};

export type AutoAssignCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  caddyType?: string;
  extraFlags?: string[] | null;
};

export type AutoAssignReservation = {
  /** 선택적 안정 식별자 (고정배치 reservationId 매칭용) */
  id?: string | number;
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

export type AssignmentKind =
  | "regular"
  | "fiftyFourHole"
  | "oneThree"
  | "oneTwo"
  | "fixed";

export type AutoAssignmentRow = {
  date: string;
  shift: ShiftPart;
  sequenceIndex: number;
  reason: string;
  reservation: AutoAssignReservation;
  caddy: AutoAssignCaddy;
  /** 페어 배치면 동일 pairId 공유 */
  pairId?: string | null;
  kind: AssignmentKind;
  note?: string | null;
};

export type UnassignedReservationRow = {
  reservation: AutoAssignReservation;
  reason: string;
};

export type SpecialUnassignedRow = {
  caddy: AutoAssignCaddy;
  reason: string;
  review: true;
  note?: string | null;
  fixedType?: string | null;
};

export type AutoAssignResultV1 = {
  date: string;
  /** 전체 배치 (고정/찾근 + 54홀 + 1·3부 + 1·2부 + 일반) */
  assignments: AutoAssignmentRow[];
  fixedAssignments: AutoAssignmentRow[];
  fiftyFourHoleAssignments: AutoAssignmentRow[];
  oneThreeAssignments: AutoAssignmentRow[];
  oneTwoAssignments: AutoAssignmentRow[];
  regularAssignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  unusedCaddies: AutoAssignCaddy[];
  /** special 배치 후보 제외 후 전달 */
  special: AutoAssignCaddy[];
  /** 고정/찾근·54홀/1·3/1·2 실패·conflict → 일반 강등 없이 review */
  specialUnassigned: SpecialUnassignedRow[];
  meta: {
    availableCount: number;
    reservationCount: number;
    assignedCount: number;
    unassignedCount: number;
    unusedCount: number;
    specialCount: number;
    fixedAssignedCount: number;
    fixedUnassignedCount: number;
    fiftyFourHoleCandidateCount: number;
    fiftyFourHoleAssignedCaddyCount: number;
    fiftyFourHoleUnassignedCount: number;
    oneThreeCandidateCount: number;
    oneThreeAssignedCaddyCount: number;
    oneThreeUnassignedCount: number;
    oneTwoCandidateCount: number;
    oneTwoAssignedCaddyCount: number;
    oneTwoUnassignedCount: number;
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
export function reservationInstantMinutes(
  r: Pick<AutoAssignReservation, "date" | "teeTime">
): number {
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

export function isCompatibleGapPair(
  a: Pick<AutoAssignReservation, "date" | "teeTime">,
  b: Pick<AutoAssignReservation, "date" | "teeTime">,
  minGapMinutes: number
): boolean {
  if (a.date !== b.date) return false;
  if (a.teeTime === b.teeTime) return false;
  const gap = minutesBetweenReservations(a, b);
  return Number.isFinite(gap) && gap >= minGapMinutes;
}

/** 두 티타임이 54홀 연속 배치 가능한지 (최소 간격) */
export function isCompatible54HolePair(
  a: Pick<AutoAssignReservation, "date" | "teeTime" | "shift">,
  b: Pick<AutoAssignReservation, "date" | "teeTime" | "shift">,
  minGapMinutes: number = MIN_54HOLE_GAP_MINUTES
): boolean {
  return isCompatibleGapPair(a, b, minGapMinutes);
}

/** 1·3부 페어 간격 가능 여부 */
export function isCompatibleOneThreePair(
  shift1: Pick<AutoAssignReservation, "date" | "teeTime" | "shift">,
  shift3: Pick<AutoAssignReservation, "date" | "teeTime" | "shift">,
  minGapMinutes: number = MIN_ONE_THREE_GAP_MINUTES
): boolean {
  if (shift1.shift !== "1부" || shift3.shift !== "3부") return false;
  return isCompatibleGapPair(shift1, shift3, minGapMinutes);
}

/** 1·2부 페어 간격 가능 여부 */
export function isCompatibleOneTwoPair(
  shift1: Pick<AutoAssignReservation, "date" | "teeTime" | "shift">,
  shift2: Pick<AutoAssignReservation, "date" | "teeTime" | "shift">,
  minGapMinutes: number = MIN_ONE_TWO_GAP_MINUTES
): boolean {
  if (shift1.shift !== "1부" || shift2.shift !== "2부") return false;
  return isCompatibleGapPair(shift1, shift2, minGapMinutes);
}

export type FiftyFourHolePair = {
  first: AutoAssignReservation;
  second: AutoAssignReservation;
  gapMinutes: number;
};

export type OneThreePair = {
  shift1: AutoAssignReservation;
  shift3: AutoAssignReservation;
  gapMinutes: number;
};

export type OneTwoPair = {
  shift1: AutoAssignReservation;
  shift2: AutoAssignReservation;
  gapMinutes: number;
};

/**
 * 남은 예약에서 시간순 첫 번째 유효 54홀 페어를 찾는다.
 * (이른 티업 + 최소 간격 이후 다음 티업)
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

/**
 * 1·3부 페어 탐색:
 * - 1부: 늦은 teeTime부터
 * - 3부: 이른 teeTime부터
 * - 간격 >= minGap 인 첫 조합
 */
export function findOneThreePair(
  reservations: AutoAssignReservation[],
  minGapMinutes: number = MIN_ONE_THREE_GAP_MINUTES
):
  | { ok: true; pair: OneThreePair }
  | {
      ok: false;
      reason:
        | typeof REASON.ONE_THREE_MISSING_SHIFT1
        | typeof REASON.ONE_THREE_MISSING_SHIFT3
        | typeof REASON.ONE_THREE_NO_PAIR;
    } {
  const shift1 = reservations
    .filter((r) => r.shift === "1부")
    .sort((a, b) => {
      // 늦은 티타임 우선
      const tb = reservationInstantMinutes(b) - reservationInstantMinutes(a);
      if (tb !== 0) return tb;
      return compareReservationOrder(a, b);
    });
  const shift3 = reservations
    .filter((r) => r.shift === "3부")
    .sort((a, b) => {
      // 이른 티타임 우선
      const ta = reservationInstantMinutes(a) - reservationInstantMinutes(b);
      if (ta !== 0) return ta;
      return compareReservationOrder(a, b);
    });

  if (shift1.length === 0) {
    return { ok: false, reason: REASON.ONE_THREE_MISSING_SHIFT1 };
  }
  if (shift3.length === 0) {
    return { ok: false, reason: REASON.ONE_THREE_MISSING_SHIFT3 };
  }

  for (const r1 of shift1) {
    const t1 = reservationInstantMinutes(r1);
    if (!Number.isFinite(t1)) continue;
    for (const r3 of shift3) {
      const t3 = reservationInstantMinutes(r3);
      if (!Number.isFinite(t3)) continue;
      const gap = t3 - t1;
      if (gap >= minGapMinutes) {
        return {
          ok: true,
          pair: { shift1: r1, shift3: r3, gapMinutes: gap },
        };
      }
    }
  }

  return { ok: false, reason: REASON.ONE_THREE_NO_PAIR };
}

export function reservationKey(r: AutoAssignReservation): string {
  if (r.id != null && String(r.id) !== "") return `id:${r.id}`;
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

export function reasonForFixedType(type: FixedAssignmentType | string): string {
  const raw = String(type || "").trim();
  const t = raw.toUpperCase().replace(/\s+/g, "_");
  if (t === "MARSHAL_CALL" || /마샬/.test(raw)) return REASON.MARSHAL_CALL;
  if (t === "DUTY_CALL" || /당번/.test(raw)) return REASON.DUTY_CALL;
  if (
    t === "SPECIAL_CALL" ||
    t.includes("SPECIAL") ||
    (/찾근/.test(raw) && !/마샬|당번/.test(raw))
  ) {
    return REASON.SPECIAL_CALL;
  }
  return REASON.FIXED_ASSIGNMENT;
}

function unknownCaddyStub(id: number): AutoAssignCaddy {
  return { id, name: `UNKNOWN#${id}`, team: "", teamOrder: 0 };
}

export function resolveFixedReservation(
  fixed: FixedAssignmentInput,
  reservations: AutoAssignReservation[]
): AutoAssignReservation | null {
  if (fixed.reservationId != null && String(fixed.reservationId) !== "") {
    const want = String(fixed.reservationId);
    const byId = reservations.find(
      (r) => r.id != null && String(r.id) === want
    );
    if (byId) return byId;
    const byKey = reservations.find((r) => reservationKey(r) === want);
    if (byKey) return byKey;
  }

  const m = fixed.reservationMatch;
  if (!m || Object.keys(m).length === 0) return null;

  const matched = reservations.filter((r) => {
    if (m.id != null && String(r.id ?? "") !== String(m.id)) return false;
    if (m.date != null && r.date !== m.date) return false;
    if (m.course != null && r.course !== m.course) return false;
    if (m.shift != null && r.shift !== m.shift) return false;
    if (m.teeTime != null && r.teeTime !== m.teeTime) return false;
    if (m.teamName != null && (r.teamName || "") !== m.teamName) return false;
    if (m.rawRowIndex != null && r.rawRowIndex !== m.rawRowIndex) return false;
    if (m.sourceSheet != null && (r.sourceSheet || "") !== m.sourceSheet) {
      return false;
    }
    return true;
  });
  return matched.length === 1 ? matched[0] : matched[0] || null;
}

type ResolvedFixed = {
  input: FixedAssignmentInput;
  caddy: AutoAssignCaddy;
  reservation: AutoAssignReservation;
  resKey: string;
  cancelled: boolean;
};

/**
 * 고정배치 / 특별찾근 — 최우선 처리.
 * - 성공: fixedAssignments
 * - 실패·conflict·캔슬: specialUnassigned (일반 강등 없음)
 * - 캔슬: 캐디·예약을 이후 단계에서 제외하고 배치하지 않음
 */
export function assignFixedPriority(input: {
  date: string;
  reservations: AutoAssignReservation[];
  caddies: AutoAssignCaddy[];
  fixedAssignments: FixedAssignmentInput[];
  minGapMinutes?: number;
}): {
  assignments: AutoAssignmentRow[];
  specialUnassigned: SpecialUnassignedRow[];
  remainingReservations: AutoAssignReservation[];
  assignedCaddyIds: Set<number>;
  excludedCaddyIds: Set<number>;
} {
  const minGap = input.minGapMinutes ?? MIN_FIXED_GAP_MINUTES;
  const caddyMap = new Map<number, AutoAssignCaddy>();
  for (const c of dedupeCaddies(input.caddies)) caddyMap.set(c.id, c);

  const specialUnassigned: SpecialUnassignedRow[] = [];
  const resolved: ResolvedFixed[] = [];

  for (const fixed of input.fixedAssignments || []) {
    const caddy = caddyMap.get(fixed.caddyId);
    if (!caddy) {
      specialUnassigned.push({
        caddy: unknownCaddyStub(fixed.caddyId),
        reason: REASON.FIXED_UNKNOWN_CADDY,
        review: true,
        note: fixed.note ?? null,
        fixedType: String(fixed.type || ""),
      });
      continue;
    }
    const reservation = resolveFixedReservation(fixed, input.reservations);
    if (!reservation) {
      specialUnassigned.push({
        caddy,
        reason: REASON.FIXED_UNKNOWN_RESERVATION,
        review: true,
        note: fixed.note ?? null,
        fixedType: String(fixed.type || ""),
      });
      continue;
    }
    resolved.push({
      input: fixed,
      caddy,
      reservation,
      resKey: reservationKey(reservation),
      cancelled: !!fixed.cancelled,
    });
  }

  const active = resolved.filter((r) => !r.cancelled);
  const cancelled = resolved.filter((r) => r.cancelled);

  const conflictIndexes = new Set<number>();

  // 동일 캐디 중복
  const byCaddy = new Map<number, number[]>();
  active.forEach((r, idx) => {
    const list = byCaddy.get(r.caddy.id) || [];
    list.push(idx);
    byCaddy.set(r.caddy.id, list);
  });
  for (const idxs of byCaddy.values()) {
    if (idxs.length > 1) {
      for (const i of idxs) conflictIndexes.add(i);
      for (const i of idxs) {
        specialUnassigned.push({
          caddy: active[i].caddy,
          reason: REASON.FIXED_CADDY_CONFLICT,
          review: true,
          note: active[i].input.note ?? null,
          fixedType: String(active[i].input.type || ""),
        });
      }
    }
  }

  // 동일 예약 중복
  const byRes = new Map<string, number[]>();
  active.forEach((r, idx) => {
    const list = byRes.get(r.resKey) || [];
    list.push(idx);
    byRes.set(r.resKey, list);
  });
  for (const idxs of byRes.values()) {
    if (idxs.length > 1) {
      for (const i of idxs) {
        if (conflictIndexes.has(i)) continue;
        conflictIndexes.add(i);
        specialUnassigned.push({
          caddy: active[i].caddy,
          reason: REASON.FIXED_RESERVATION_CONFLICT,
          review: true,
          note: active[i].input.note ?? null,
          fixedType: String(active[i].input.type || ""),
        });
      }
    }
  }

  // 시간 겹침 (동일 캐디·서로 다른 예약, gap <= minGap)
  for (const [caddyId, idxs] of byCaddy.entries()) {
    if (idxs.length < 2) continue;
    void caddyId;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const ra = active[idxs[a]];
        const rb = active[idxs[b]];
        const gap = minutesBetweenReservations(ra.reservation, rb.reservation);
        if (Number.isFinite(gap) && gap <= minGap) {
          for (const i of [idxs[a], idxs[b]]) {
            if (conflictIndexes.has(i)) continue;
            conflictIndexes.add(i);
            specialUnassigned.push({
              caddy: active[i].caddy,
              reason: REASON.FIXED_TIME_OVERLAP,
              review: true,
              note: active[i].input.note ?? null,
              fixedType: String(active[i].input.type || ""),
            });
          }
        }
      }
    }
  }

  // cancelled + active same caddy → conflict active, keep cancelled exclusion
  const cancelledCaddyIds = new Set(cancelled.map((c) => c.caddy.id));
  active.forEach((r, idx) => {
    if (cancelledCaddyIds.has(r.caddy.id) && !conflictIndexes.has(idx)) {
      conflictIndexes.add(idx);
      specialUnassigned.push({
        caddy: r.caddy,
        reason: REASON.FIXED_CADDY_CONFLICT,
        review: true,
        note: r.input.note ?? null,
        fixedType: String(r.input.type || ""),
      });
    }
  });

  const assignments: AutoAssignmentRow[] = [];
  const assignedCaddyIds = new Set<number>();
  const excludedCaddyIds = new Set<number>();
  const consumedKeys = new Set<string>();

  active.forEach((r, idx) => {
    if (conflictIndexes.has(idx)) {
      excludedCaddyIds.add(r.caddy.id);
      return;
    }
    const reason = reasonForFixedType(r.input.type);
    assignments.push({
      date: input.date,
      shift: r.reservation.shift as ShiftPart,
      sequenceIndex: -1,
      reason,
      reservation: r.reservation,
      caddy: r.caddy,
      pairId: null,
      kind: "fixed",
      note: r.input.note ?? null,
    });
    assignedCaddyIds.add(r.caddy.id);
    excludedCaddyIds.add(r.caddy.id);
    consumedKeys.add(r.resKey);
  });

  for (const r of cancelled) {
    excludedCaddyIds.add(r.caddy.id);
    consumedKeys.add(r.resKey);
    specialUnassigned.push({
      caddy: r.caddy,
      reason: REASON.FIXED_CANCELLED,
      review: true,
      note: r.input.note ?? null,
      fixedType: String(r.input.type || ""),
    });
  }

  const remainingReservations = input.reservations.filter(
    (r) => !consumedKeys.has(reservationKey(r))
  );

  return {
    assignments,
    specialUnassigned,
    remainingReservations,
    assignedCaddyIds,
    excludedCaddyIds,
  };
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
        sequenceIndex: -1,
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
 * 1·3부 신청자 우선 배치.
 * 1부 후반 + 3부 초반 페어, 최소 간격 검증.
 * 실패 시 일반 강등 없이 specialUnassigned.
 */
export function assignOneThreePriority(input: {
  date: string;
  reservations: AutoAssignReservation[];
  oneThreeCandidates: AutoAssignCaddy[];
  minGapMinutes?: number;
}): {
  assignments: AutoAssignmentRow[];
  specialUnassigned: SpecialUnassignedRow[];
  remainingReservations: AutoAssignReservation[];
  assignedCaddyIds: Set<number>;
} {
  const minGap = input.minGapMinutes ?? MIN_ONE_THREE_GAP_MINUTES;
  const candidates = dedupeCaddies([...input.oneThreeCandidates]).sort(
    compareCaddyOrder
  );
  let remaining = [...input.reservations];
  const assignments: AutoAssignmentRow[] = [];
  const specialUnassigned: SpecialUnassignedRow[] = [];
  const assignedCaddyIds = new Set<number>();

  for (const caddy of candidates) {
    const shift1Count = remaining.filter((r) => r.shift === "1부").length;
    const shift3Count = remaining.filter((r) => r.shift === "3부").length;
    if (shift1Count === 0 && shift3Count === 0) {
      specialUnassigned.push({
        caddy,
        reason: REASON.ONE_THREE_INSUFFICIENT_RESERVATIONS,
        review: true,
      });
      continue;
    }

    const found = findOneThreePair(remaining, minGap);
    if (!found.ok) {
      specialUnassigned.push({
        caddy,
        reason: found.reason,
        review: true,
      });
      continue;
    }

    const { shift1, shift3, gapMinutes } = found.pair;
    if (!isCompatibleOneThreePair(shift1, shift3, minGap)) {
      specialUnassigned.push({
        caddy,
        reason: REASON.ONE_THREE_NO_PAIR,
        review: true,
      });
      continue;
    }

    const pairId = `13-${caddy.id}-${shift1.teeTime}-${shift3.teeTime}`;
    for (const reservation of [shift1, shift3]) {
      assignments.push({
        date: input.date,
        shift: reservation.shift as ShiftPart,
        sequenceIndex: -1,
        reason: REASON.ONE_THREE_PRIORITY,
        reservation,
        caddy,
        pairId,
        kind: "oneThree",
      });
    }

    // gapMinutes kept for future debug; referenced to avoid unused lint
    void gapMinutes;

    assignedCaddyIds.add(caddy.id);
    const taken = new Set([shift1, shift3].map(reservationKey));
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
 * 1·2부 페어 탐색:
 * - 1부: 늦은 teeTime부터 (중후반~후반 우선)
 * - 2부: 이른 teeTime부터
 * - 간격 >= minGap 인 첫 조합
 */
export function findOneTwoPair(
  reservations: AutoAssignReservation[],
  minGapMinutes: number = MIN_ONE_TWO_GAP_MINUTES
):
  | { ok: true; pair: OneTwoPair }
  | {
      ok: false;
      reason:
        | typeof REASON.ONE_TWO_MISSING_SHIFT1
        | typeof REASON.ONE_TWO_MISSING_SHIFT2
        | typeof REASON.ONE_TWO_NO_PAIR;
    } {
  const shift1 = reservations
    .filter((r) => r.shift === "1부")
    .sort((a, b) => {
      const tb = reservationInstantMinutes(b) - reservationInstantMinutes(a);
      if (tb !== 0) return tb;
      return compareReservationOrder(a, b);
    });
  const shift2 = reservations
    .filter((r) => r.shift === "2부")
    .sort((a, b) => {
      const ta = reservationInstantMinutes(a) - reservationInstantMinutes(b);
      if (ta !== 0) return ta;
      return compareReservationOrder(a, b);
    });

  if (shift1.length === 0) {
    return { ok: false, reason: REASON.ONE_TWO_MISSING_SHIFT1 };
  }
  if (shift2.length === 0) {
    return { ok: false, reason: REASON.ONE_TWO_MISSING_SHIFT2 };
  }

  for (const r1 of shift1) {
    const t1 = reservationInstantMinutes(r1);
    if (!Number.isFinite(t1)) continue;
    for (const r2 of shift2) {
      const t2 = reservationInstantMinutes(r2);
      if (!Number.isFinite(t2)) continue;
      const gap = t2 - t1;
      if (gap >= minGapMinutes) {
        return {
          ok: true,
          pair: { shift1: r1, shift2: r2, gapMinutes: gap },
        };
      }
    }
  }

  return { ok: false, reason: REASON.ONE_TWO_NO_PAIR };
}

/**
 * 1·2부 신청자 우선 배치.
 * 1부 중후반~후반 + 2부 초반 페어, 최소 간격 검증.
 * 실패 시 일반 강등 없이 specialUnassigned.
 */
export function assignOneTwoPriority(input: {
  date: string;
  reservations: AutoAssignReservation[];
  oneTwoCandidates: AutoAssignCaddy[];
  minGapMinutes?: number;
}): {
  assignments: AutoAssignmentRow[];
  specialUnassigned: SpecialUnassignedRow[];
  remainingReservations: AutoAssignReservation[];
  assignedCaddyIds: Set<number>;
} {
  const minGap = input.minGapMinutes ?? MIN_ONE_TWO_GAP_MINUTES;
  const candidates = dedupeCaddies([...input.oneTwoCandidates]).sort(
    compareCaddyOrder
  );
  let remaining = [...input.reservations];
  const assignments: AutoAssignmentRow[] = [];
  const specialUnassigned: SpecialUnassignedRow[] = [];
  const assignedCaddyIds = new Set<number>();

  for (const caddy of candidates) {
    const shift1Count = remaining.filter((r) => r.shift === "1부").length;
    const shift2Count = remaining.filter((r) => r.shift === "2부").length;
    if (shift1Count === 0 && shift2Count === 0) {
      specialUnassigned.push({
        caddy,
        reason: REASON.ONE_TWO_INSUFFICIENT_RESERVATIONS,
        review: true,
      });
      continue;
    }

    const found = findOneTwoPair(remaining, minGap);
    if (!found.ok) {
      specialUnassigned.push({
        caddy,
        reason: found.reason,
        review: true,
      });
      continue;
    }

    const { shift1, shift2, gapMinutes } = found.pair;
    if (!isCompatibleOneTwoPair(shift1, shift2, minGap)) {
      specialUnassigned.push({
        caddy,
        reason: REASON.ONE_TWO_NO_PAIR,
        review: true,
      });
      continue;
    }

    const pairId = `12-${caddy.id}-${shift1.teeTime}-${shift2.teeTime}`;
    for (const reservation of [shift1, shift2]) {
      assignments.push({
        date: input.date,
        shift: reservation.shift as ShiftPart,
        sequenceIndex: -1,
        reason: REASON.ONE_TWO_PRIORITY,
        reservation,
        caddy,
        pairId,
        kind: "oneTwo",
      });
    }

    void gapMinutes;

    assignedCaddyIds.add(caddy.id);
    const taken = new Set([shift1, shift2].map(reservationKey));
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
 * 자동배치:
 * 0) 고정/특별찾근 1) 54홀 2) 1·3부 3) 1·2부 4) 일반 순번
 * - special/고정 후보는 일반 available/포인터에서 제외
 * - special 실패·conflict·캔슬은 specialUnassigned (일반 강등 없음)
 */
export function computeAutoAssignmentsV1(input: {
  date: string;
  reservations: AutoAssignReservation[];
  available: AutoAssignCaddy[];
  special?: AutoAssignCaddy[];
  /** 고정배치 / 특별찾근 */
  fixedAssignments?: FixedAssignmentInput[];
  /** 고정배치 조회용 추가 캐디 목록(optional) */
  caddyDirectory?: AutoAssignCaddy[];
  /** 54홀 신청/지정 후보 — 명시적 입력 */
  fiftyFourHole?: AutoAssignCaddy[];
  /** 1·3부 신청자 후보 — 명시적 입력 */
  oneThreeCandidates?: AutoAssignCaddy[];
  /** 1·2부 신청자 후보 — 명시적 입력 */
  oneTwoCandidates?: AutoAssignCaddy[];
  min54HoleGapMinutes?: number;
  minOneThreeGapMinutes?: number;
  minOneTwoGapMinutes?: number;
}): AutoAssignResultV1 {
  const date = input.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }

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

  const caddyDirectory = dedupeCaddies([
    ...(input.caddyDirectory || []),
    ...(input.available || []),
    ...(input.special || []),
    ...(input.fiftyFourHole || []),
    ...(input.oneThreeCandidates || []),
    ...(input.oneTwoCandidates || []),
  ]);

  // 0) 고정배치 / 특별찾근 (최우선)
  const fixed = assignFixedPriority({
    date,
    reservations: eligible,
    caddies: caddyDirectory,
    fixedAssignments: input.fixedAssignments || [],
  });

  const fixedIds = fixed.excludedCaddyIds;

  const fiftyFourHole = dedupeCaddies([...(input.fiftyFourHole || [])])
    .filter((c) => !fixedIds.has(c.id))
    .sort(compareCaddyOrder);
  const fiftyFourIds = new Set(fiftyFourHole.map((c) => c.id));

  const oneThreeCandidates = dedupeCaddies([...(input.oneThreeCandidates || [])])
    .filter((c) => !fixedIds.has(c.id) && !fiftyFourIds.has(c.id))
    .sort(compareCaddyOrder);
  const oneThreeIds = new Set(oneThreeCandidates.map((c) => c.id));

  const oneTwoCandidates = dedupeCaddies([...(input.oneTwoCandidates || [])])
    .filter(
      (c) =>
        !fixedIds.has(c.id) && !fiftyFourIds.has(c.id) && !oneThreeIds.has(c.id)
    )
    .sort(compareCaddyOrder);
  const oneTwoIds = new Set(oneTwoCandidates.map((c) => c.id));

  const specialExclude = new Set<number>([
    ...fixedIds,
    ...fiftyFourIds,
    ...oneThreeIds,
    ...oneTwoIds,
  ]);
  const special = dedupeCaddies([...(input.special || [])])
    .filter((c) => !specialExclude.has(c.id))
    .sort(compareCaddyOrder);

  const available = dedupeCaddies([...(input.available || [])])
    .filter((c) => !specialExclude.has(c.id))
    .sort(compareCaddyOrder);

  // 1) 54홀
  const fiftyFour = assignFiftyFourHolePriority({
    date,
    reservations: fixed.remainingReservations,
    fiftyFourHole,
    minGapMinutes: input.min54HoleGapMinutes,
  });

  // 2) 1·3부
  const oneThree = assignOneThreePriority({
    date,
    reservations: fiftyFour.remainingReservations,
    oneThreeCandidates,
    minGapMinutes: input.minOneThreeGapMinutes,
  });

  // 3) 1·2부
  const oneTwo = assignOneTwoPriority({
    date,
    reservations: oneThree.remainingReservations,
    oneTwoCandidates,
    minGapMinutes: input.minOneTwoGapMinutes,
  });

  const fixedAssignments = fixed.assignments;
  const fiftyFourHoleAssignments = fiftyFour.assignments;
  const oneThreeAssignments = oneThree.assignments;
  const oneTwoAssignments = oneTwo.assignments;
  const specialUnassigned = [
    ...fixed.specialUnassigned,
    ...fiftyFour.specialUnassigned,
    ...oneThree.specialUnassigned,
    ...oneTwo.specialUnassigned,
  ];
  const remainingEligible = oneTwo.remainingReservations.sort(
    compareReservationOrder
  );

  // 4) 일반 순번 (포인터는 여기서만 전진)
  const regularAssignments: AutoAssignmentRow[] = [];
  const usedCaddyIds = new Set<number>([
    ...fixed.assignedCaddyIds,
    ...fiftyFour.assignedCaddyIds,
    ...oneThree.assignedCaddyIds,
    ...oneTwo.assignedCaddyIds,
  ]);
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

  for (const a of [
    ...fixedAssignments,
    ...fiftyFourHoleAssignments,
    ...oneThreeAssignments,
    ...oneTwoAssignments,
  ]) {
    byShift[a.shift].assigned += 1;
  }

  const assignments = [
    ...fixedAssignments,
    ...fiftyFourHoleAssignments,
    ...oneThreeAssignments,
    ...oneTwoAssignments,
    ...regularAssignments,
  ].sort((a, b) => {
    const sr = shiftRank(a.shift) - shiftRank(b.shift);
    if (sr !== 0) return sr;
    return a.reservation.teeTime.localeCompare(b.reservation.teeTime);
  });

  const unusedCaddies = available.filter((c) => !usedCaddyIds.has(c.id));
  const fiftyFourHoleAssignedCaddyCount = new Set(
    fiftyFourHoleAssignments.map((a) => a.caddy.id)
  ).size;
  const oneThreeAssignedCaddyCount = new Set(
    oneThreeAssignments.map((a) => a.caddy.id)
  ).size;
  const oneTwoAssignedCaddyCount = new Set(
    oneTwoAssignments.map((a) => a.caddy.id)
  ).size;

  return {
    date,
    assignments,
    fixedAssignments,
    fiftyFourHoleAssignments,
    oneThreeAssignments,
    oneTwoAssignments,
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
      fixedAssignedCount: fixedAssignments.length,
      fixedUnassignedCount: fixed.specialUnassigned.length,
      fiftyFourHoleCandidateCount: fiftyFourHole.length,
      fiftyFourHoleAssignedCaddyCount,
      fiftyFourHoleUnassignedCount: fiftyFour.specialUnassigned.length,
      oneThreeCandidateCount: oneThreeCandidates.length,
      oneThreeAssignedCaddyCount,
      oneThreeUnassignedCount: oneThree.specialUnassigned.length,
      oneTwoCandidateCount: oneTwoCandidates.length,
      oneTwoAssignedCaddyCount,
      oneTwoUnassignedCount: oneTwo.specialUnassigned.length,
      byShift,
      finalPointer: available.length === 0 ? 0 : pointer,
    },
  };
}
