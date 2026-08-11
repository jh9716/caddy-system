/**
 * 자동배치 엔진 (3~8단계)
 * - 순수 함수: DB write 없음
 * - 우선순위: 고정/특별찾근 → 54홀 → 1·3부 → 1·2부 → 일반 순번
 * - 일반: HOUSE 순번 + 부별 스페어1·2, 3부는 스페어→THIRD→남은 HOUSE
 * - DRIVING은 일반 HOUSE/THIRD 순번에 섞지 않음
 * - 8단계: 일반 예약 캔슬/추가 시 regular reflow (special 보호, 스페어·3부 재계산)
 */

import { PRIMARY_TEAMS } from "@/lib/caddyManage";
import {
  COURSE_CODES,
  normalizeCourse,
  SHIFT_PARTS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

/** 배치/표시용 코스 고정 순서 */
export const COURSE_ORDER: readonly CourseCode[] = COURSE_CODES;

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
  REGULAR_CANCEL_REFLOW: "REGULAR_CANCEL_REFLOW",
  REGULAR_ADD_REFLOW: "REGULAR_ADD_REFLOW",
  REGULAR_MIXED_REFLOW: "REGULAR_MIXED_REFLOW",
  CLOSED_COURSE: "CLOSED_COURSE",
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

/** 일반 순번 타입 풀 (HOUSE / THIRD / DRIVING 분리) */
export type AssignCaddyType = "HOUSE" | "THIRD" | "DRIVING";

/** 부별 스페어 (예약 배치 아님 — 대기, confirm 시 Schedule에 저장하지 않음) */
export type SpareCaddyInfo = {
  caddyId: number;
  name: string;
  team: string;
  teamOrder: number;
};

export type SpareByShift = {
  shift: ShiftPart;
  spare1: SpareCaddyInfo | null;
  spare2: SpareCaddyInfo | null;
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
  /** Open/Close에서 OFF된 코스 예약 (삭제하지 않고 분리) */
  closedCourseReservations: UnassignedReservationRow[];
  unusedCaddies: AutoAssignCaddy[];
  /** special 배치 후보 제외 후 전달 */
  special: AutoAssignCaddy[];
  /** 고정/찾근·54홀/1·3/1·2 실패·conflict → 일반 강등 없이 review */
  specialUnassigned: SpecialUnassignedRow[];
  /** 이번 실행에 열린 코스 (기본 4개 전부) */
  openCourses: CourseCode[];
  /** 부별 HOUSE 스페어1·2 (대기, 예약 row 아님) */
  sparesByShift: SpareByShift[];
  meta: {
    availableCount: number;
    reservationCount: number;
    assignedCount: number;
    unassignedCount: number;
    closedCourseCount: number;
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
    housePoolCount: number;
    thirdPoolCount: number;
    drivingPoolCount: number;
    byShift: Record<
      ShiftPart,
      { reservations: number; assigned: number; unassigned: number }
    >;
    finalPointer: number;
  };
};

export type ReservationChangeEvent =
  | {
      type: "CANCEL_RESERVATION";
      reservationId?: string | number;
      reservationKey?: string;
      reservationMatch?: Partial<
        Pick<
          AutoAssignReservation,
          | "date"
          | "course"
          | "shift"
          | "teeTime"
          | "teamName"
          | "rawRowIndex"
          | "id"
        >
      >;
    }
  | {
      type: "ADD_RESERVATION";
      reservation: AutoAssignReservation;
    };

export type ReflowChangeKind =
  | "movedBackward"
  | "movedForward"
  | "unchanged"
  | "newlyAssigned"
  | "becameUnassigned";

export type ReflowCaddyChange = {
  caddy: AutoAssignCaddy;
  kind: ReflowChangeKind;
  beforeReservation: AutoAssignReservation | null;
  afterReservation: AutoAssignReservation | null;
  beforeOrderIndex: number | null;
  afterOrderIndex: number | null;
};

export type RegularReflowResult = {
  date: string;
  reason: string;
  before: AutoAssignResultV1;
  after: AutoAssignResultV1;
  changes: ReflowCaddyChange[];
  summary: {
    movedBackward: number;
    movedForward: number;
    unchanged: number;
    newlyAssigned: number;
    becameUnassigned: number;
    specialPreserved: number;
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

/** 예약 course 문자열 → CourseCode (미상이면 null) */
export function resolveCourseCode(
  course: string | null | undefined
): CourseCode | null {
  if (course == null || course === "") return null;
  const direct = String(course).trim().toUpperCase();
  if ((COURSE_ORDER as readonly string[]).includes(direct)) {
    return direct as CourseCode;
  }
  return normalizeCourse(String(course));
}

export function courseRank(course: string | null | undefined): number {
  const code = resolveCourseCode(course);
  if (!code) return 99;
  return COURSE_ORDER.indexOf(code);
}

/**
 * 정렬: shift → teeTime → courseOrder(VERTHILL→SKY→OCEAN→LAKE)
 * 현장 슬롯 큐: 같은 시각에 베→스→오→레 후 다음 시각 (코스별 전체 묶음 아님)
 */
export function compareReservationOrder(
  a: AutoAssignReservation,
  b: AutoAssignReservation
): number {
  const sr = shiftRank(String(a.shift)) - shiftRank(String(b.shift));
  if (sr !== 0) return sr;
  if (a.teeTime !== b.teeTime) return a.teeTime.localeCompare(b.teeTime);
  const cr = courseRank(a.course) - courseRank(b.course);
  if (cr !== 0) return cr;
  const ra = a.rawRowIndex ?? 0;
  const rb = b.rawRowIndex ?? 0;
  if (ra !== rb) return ra - rb;
  return String(a.teamName || "").localeCompare(String(b.teamName || ""), "ko");
}

export function compareAssignmentOrder(
  a: AutoAssignmentRow,
  b: AutoAssignmentRow
): number {
  return compareReservationOrder(a.reservation, b.reservation);
}

/** openCourses 정규화 — 미지정/빈 입력이면 4코스 전부 ON */
export function normalizeOpenCourses(
  openCourses?: readonly string[] | null
): CourseCode[] {
  if (openCourses == null) return [...COURSE_ORDER];
  const set = new Set<CourseCode>();
  for (const raw of openCourses) {
    const code = resolveCourseCode(raw);
    if (code) set.add(code);
  }
  // 명시적으로 [] 가 오면 전부 OFF 허용
  if (openCourses.length === 0) return [];
  return COURSE_ORDER.filter((c) => set.has(c));
}

export function isCourseOpen(
  course: string | null | undefined,
  openCourses: readonly CourseCode[]
): boolean {
  const code = resolveCourseCode(course);
  if (!code) return false;
  return openCourses.includes(code);
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

/** caddyType 정규화 — 미지정은 HOUSE */
export function normalizeAssignCaddyType(
  input?: string | null
): AssignCaddyType {
  const v = String(input ?? "HOUSE").trim().toUpperCase();
  if (v === "THIRD") return "THIRD";
  if (v === "DRIVING") return "DRIVING";
  return "HOUSE";
}

/** 일반 순번용 타입별 풀 분리 (정렬 포함). DRIVING은 3부 HOUSE 순번에 섞지 않음. */
export function splitCaddyPools(caddies: AutoAssignCaddy[]): {
  house: AutoAssignCaddy[];
  third: AutoAssignCaddy[];
  driving: AutoAssignCaddy[];
} {
  const house: AutoAssignCaddy[] = [];
  const third: AutoAssignCaddy[] = [];
  const driving: AutoAssignCaddy[] = [];
  for (const c of dedupeCaddies(caddies || [])) {
    const t = normalizeAssignCaddyType(c.caddyType);
    if (t === "THIRD") third.push(c);
    else if (t === "DRIVING") driving.push(c);
    else house.push(c);
  }
  house.sort(compareCaddyOrder);
  third.sort(compareCaddyOrder);
  driving.sort(compareCaddyOrder);
  return { house, third, driving };
}

function toSpareInfo(caddy: AutoAssignCaddy | null | undefined): SpareCaddyInfo | null {
  if (!caddy) return null;
  return {
    caddyId: caddy.id,
    name: caddy.name,
    team: caddy.team,
    teamOrder: caddy.teamOrder,
  };
}

function emptySparesByShift(): SpareByShift[] {
  return SHIFT_PARTS.map((shift) => ({
    shift,
    spare1: null,
    spare2: null,
  }));
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
 * 일반 순번 배치
 * - HOUSE 풀만 1·2부 순번/스페어에 사용 (special 제외된 풀을 넘길 것)
 * - 스페어1·2 = 해당 부 배치 N명 다음 HOUSE 2명 (대기, 예약 아님)
 * - 다음 부 HOUSE 시작 = 직전 부 스페어1 (= N)
 * - 3부: 2부 스페어1 → 스페어2 → THIRD 전체 순번 → 남은 HOUSE
 * - DRIVING은 일반 순번에 섞지 않음
 * - HOUSE 소진 시 wrap (기존 동작 유지)
 */
export function assignRegularSequence(input: {
  date: string;
  /** 혼합 가용(하위 호환). house/third가 있으면 무시됨 */
  available?: AutoAssignCaddy[];
  house?: AutoAssignCaddy[];
  third?: AutoAssignCaddy[];
  reservations: AutoAssignReservation[];
  reasonCode?: string;
}): {
  assignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  finalPointer: number;
  byShift: Record<
    ShiftPart,
    { reservations: number; assigned: number; unassigned: number }
  >;
  sparesByShift: SpareByShift[];
} {
  const pools =
    input.house != null
      ? {
          house: dedupeCaddies([...(input.house || [])]).sort(compareCaddyOrder),
          third: dedupeCaddies([...(input.third || [])]).sort(compareCaddyOrder),
          driving: [] as AutoAssignCaddy[],
        }
      : splitCaddyPools(input.available || []);

  const house = pools.house;
  const third = pools.third;
  const reservations = [...(input.reservations || [])].sort(
    compareReservationOrder
  );
  const reasonCode = input.reasonCode || REASON.REGULAR_SEQUENCE;
  const byShift = emptyShiftMeta();
  for (const shift of SHIFT_PARTS) {
    byShift[shift].reservations = reservations.filter(
      (r) => r.shift === shift
    ).length;
  }

  const assignments: AutoAssignmentRow[] = [];
  const unassignedReservations: UnassignedReservationRow[] = [];
  /** 다음 부가 시작할 HOUSE 절대 인덱스 (스페어1 위치, wrap 없이 누적) */
  let houseStart = 0;
  const sparesByShift: SpareByShift[] = [];

  for (const shift of SHIFT_PARTS) {
    const shiftReservations = reservations.filter((r) => r.shift === shift);
    const usedInShift = new Set<number>();
    let houseAssigned = 0;

    if (shift === "3부") {
      const order: Array<{ caddy: AutoAssignCaddy; sequenceIndex: number }> =
        [];
      const seen = new Set<number>();
      const pushHouse = (idx: number) => {
        if (idx < 0 || idx >= house.length) return;
        const c = house[idx];
        if (seen.has(c.id)) return;
        seen.add(c.id);
        order.push({ caddy: c, sequenceIndex: idx });
      };
      pushHouse(houseStart);
      pushHouse(houseStart + 1);
      for (let i = 0; i < third.length; i++) {
        const c = third[i];
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        order.push({ caddy: c, sequenceIndex: 10_000 + i });
      }
      for (let i = houseStart + 2; i < house.length; i++) pushHouse(i);
      for (let i = 0; i < house.length && i < houseStart + 2; i++) pushHouse(i);

      let oi = 0;
      for (const reservation of shiftReservations) {
        if (order.length === 0) {
          unassignedReservations.push({
            reservation,
            reason: "가용 캐디 없음",
          });
          byShift[shift].unassigned += 1;
          continue;
        }

        let picked: { caddy: AutoAssignCaddy; sequenceIndex: number } | null =
          null;
        while (oi < order.length) {
          const cand = order[oi++];
          if (usedInShift.has(cand.caddy.id)) continue;
          picked = cand;
          break;
        }

        if (!picked) {
          unassignedReservations.push({
            reservation,
            reason: `같은 부 중복 방지로 배치 불가(가용 HOUSE ${house.length}/THIRD ${third.length})`,
          });
          byShift[shift].unassigned += 1;
          continue;
        }

        usedInShift.add(picked.caddy.id);
        if (normalizeAssignCaddyType(picked.caddy.caddyType) === "HOUSE") {
          houseAssigned += 1;
        }
        assignments.push({
          date: input.date,
          shift,
          sequenceIndex: picked.sequenceIndex,
          reason: `${reasonCode}(${shift}, seq=${picked.sequenceIndex})`,
          reservation,
          caddy: picked.caddy,
          pairId: null,
          kind: "regular",
        });
        byShift[shift].assigned += 1;
      }
    } else {
      // 1·2부: HOUSE만, houseStart부터 wrap
      let cursor =
        house.length === 0 ? 0 : ((houseStart % house.length) + house.length) % house.length;

      for (const reservation of shiftReservations) {
        if (house.length === 0) {
          unassignedReservations.push({
            reservation,
            reason: "가용 캐디 없음",
          });
          byShift[shift].unassigned += 1;
          continue;
        }

        let picked: AutoAssignCaddy | null = null;
        let pickedIndex = -1;
        for (let attempt = 0; attempt < house.length; attempt++) {
          const idx = (cursor + attempt) % house.length;
          const caddy = house[idx];
          if (usedInShift.has(caddy.id)) continue;
          picked = caddy;
          pickedIndex = idx;
          cursor = (idx + 1) % house.length;
          break;
        }

        if (!picked || pickedIndex < 0) {
          unassignedReservations.push({
            reservation,
            reason: `같은 부 중복 방지로 배치 불가(가용 ${house.length}명)`,
          });
          byShift[shift].unassigned += 1;
          continue;
        }

        usedInShift.add(picked.id);
        houseAssigned += 1;
        assignments.push({
          date: input.date,
          shift,
          sequenceIndex: pickedIndex,
          reason: `${reasonCode}(${shift}, seq=${pickedIndex})`,
          reservation,
          caddy: picked,
          pairId: null,
          kind: "regular",
        });
        byShift[shift].assigned += 1;
      }
    }

    const spareBase = houseStart + houseAssigned;
    sparesByShift.push({
      shift,
      spare1: toSpareInfo(
        spareBase >= 0 && spareBase < house.length ? house[spareBase] : null
      ),
      spare2: toSpareInfo(
        spareBase + 1 >= 0 && spareBase + 1 < house.length
          ? house[spareBase + 1]
          : null
      ),
    });
    houseStart = spareBase;
  }

  const finalPointer =
    house.length === 0 ? 0 : ((houseStart % house.length) + house.length) % house.length;

  return {
    assignments,
    unassignedReservations,
    finalPointer,
    byShift,
    sparesByShift:
      sparesByShift.length === SHIFT_PARTS.length
        ? sparesByShift
        : emptySparesByShift(),
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
  /**
   * 운영 코스 Open 목록. 미지정 시 4코스 전부 ON.
   * OFF 코스 예약은 closedCourseReservations 로 분리 (CLOSED_COURSE).
   */
  openCourses?: readonly string[] | null;
  min54HoleGapMinutes?: number;
  minOneThreeGapMinutes?: number;
  minOneTwoGapMinutes?: number;
}): AutoAssignResultV1 {
  const date = input.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const openCourses = normalizeOpenCourses(input.openCourses);
  const unassignedReservations: UnassignedReservationRow[] = [];
  const closedCourseReservations: UnassignedReservationRow[] = [];
  const byShift = emptyShiftMeta();

  const dayReservations = (input.reservations || []).map((r) =>
    r.date ? r : { ...r, date }
  );

  const eligible: AutoAssignReservation[] = [];
  for (const r of dayReservations) {
    if (r.date && r.date !== date) continue;
    if (!isCourseOpen(r.course, openCourses)) {
      closedCourseReservations.push({
        reservation: r,
        reason: REASON.CLOSED_COURSE,
      });
      continue;
    }
    const check = isAssignableReservation(r, date);
    if (!check.ok) {
      unassignedReservations.push({ reservation: r, reason: check.reason });
      continue;
    }
    eligible.push(r);
  }
  eligible.sort(compareReservationOrder);
  closedCourseReservations.sort((a, b) =>
    compareReservationOrder(a.reservation, b.reservation)
  );
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
  const pools = splitCaddyPools(available);

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

  // 4) 일반 순번 — HOUSE 스페어 + 3부 THIRD (DRIVING 비혼합)
  const regular = assignRegularSequence({
    date,
    house: pools.house,
    third: pools.third,
    reservations: remainingEligible,
    reasonCode: REASON.REGULAR_SEQUENCE,
  });
  const regularAssignments = regular.assignments;
  unassignedReservations.push(...regular.unassignedReservations);

  for (const shift of SHIFT_PARTS) {
    byShift[shift].assigned += regular.byShift[shift].assigned;
    byShift[shift].unassigned += regular.byShift[shift].unassigned;
  }

  for (const a of [
    ...fixedAssignments,
    ...fiftyFourHoleAssignments,
    ...oneThreeAssignments,
    ...oneTwoAssignments,
  ]) {
    byShift[a.shift].assigned += 1;
  }

  const usedCaddyIds = new Set<number>([
    ...fixed.assignedCaddyIds,
    ...fiftyFour.assignedCaddyIds,
    ...oneThree.assignedCaddyIds,
    ...oneTwo.assignedCaddyIds,
    ...regularAssignments.map((a) => a.caddy.id),
  ]);

  const assignments = [
    ...fixedAssignments,
    ...fiftyFourHoleAssignments,
    ...oneThreeAssignments,
    ...oneTwoAssignments,
    ...regularAssignments,
  ].sort(compareAssignmentOrder);

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
    closedCourseReservations,
    unusedCaddies,
    special,
    specialUnassigned,
    openCourses,
    sparesByShift: regular.sparesByShift,
    meta: {
      availableCount: available.length,
      reservationCount: eligible.length,
      assignedCount: assignments.length,
      unassignedCount: unassignedReservations.length,
      closedCourseCount: closedCourseReservations.length,
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
      housePoolCount: pools.house.length,
      thirdPoolCount: pools.third.length,
      drivingPoolCount: pools.driving.length,
      byShift,
      finalPointer: regular.finalPointer,
    },
  };
}

function matchesCancelEvent(
  reservation: AutoAssignReservation,
  event: Extract<ReservationChangeEvent, { type: "CANCEL_RESERVATION" }>
): boolean {
  if (event.reservationId != null && String(event.reservationId) !== "") {
    const want = String(event.reservationId);
    if (reservation.id != null && String(reservation.id) === want) return true;
    if (reservationKey(reservation) === want) return true;
  }
  if (event.reservationKey && reservationKey(reservation) === event.reservationKey) {
    return true;
  }
  const m = event.reservationMatch;
  if (!m) return false;
  if (m.id != null && String(reservation.id ?? "") !== String(m.id)) return false;
  if (m.date != null && reservation.date !== m.date) return false;
  if (m.course != null && reservation.course !== m.course) return false;
  if (m.shift != null && reservation.shift !== m.shift) return false;
  if (m.teeTime != null && reservation.teeTime !== m.teeTime) return false;
  if (m.teamName != null && (reservation.teamName || "") !== m.teamName) {
    return false;
  }
  if (m.rawRowIndex != null && reservation.rawRowIndex !== m.rawRowIndex) {
    return false;
  }
  return true;
}

function specialAssignmentRows(result: AutoAssignResultV1): AutoAssignmentRow[] {
  return [
    ...result.fixedAssignments,
    ...result.fiftyFourHoleAssignments,
    ...result.oneThreeAssignments,
    ...result.oneTwoAssignments,
  ];
}

function protectedCaddyIds(result: AutoAssignResultV1): Set<number> {
  const ids = new Set<number>();
  for (const a of specialAssignmentRows(result)) ids.add(a.caddy.id);
  for (const u of result.specialUnassigned) {
    if (u.reason === REASON.FIXED_CANCELLED) ids.add(u.caddy.id);
  }
  return ids;
}

function protectedReservationKeys(result: AutoAssignResultV1): Set<string> {
  return new Set(
    specialAssignmentRows(result).map((a) => reservationKey(a.reservation))
  );
}

function orderIndexMap(
  rows: AutoAssignmentRow[]
): Map<number, { index: number; reservation: AutoAssignReservation }> {
  const sorted = [...rows].sort((a, b) =>
    compareReservationOrder(a.reservation, b.reservation)
  );
  const map = new Map<
    number,
    { index: number; reservation: AutoAssignReservation }
  >();
  sorted.forEach((row, index) => {
    map.set(row.caddy.id, { index, reservation: row.reservation });
  });
  return map;
}

/**
 * 일반 예약 캔슬/추가 후 일반 순번만 재계산 (special 보호).
 *
 * 알고리즘:
 * 1) previous의 special(고정/찾근·54·1·3·1·2) 배치·FIXED_CANCELLED 캐디를 잠금
 * 2) 일반 예약 집합에 이벤트 적용 (special 예약 CANCEL은 일반 풀에서만 무시, 캐디 재투입 금지)
 * 3) regularCaddyPool에서 잠금 캐디 제외 후 assignRegularSequence 재실행
 * 4) special 배치는 그대로 유지하고 before/after diff 반환
 */
export function reflowRegularAssignments(input: {
  previous: AutoAssignResultV1;
  /** 원본 일반 available 풀 (정렬 전/후 모두 허용 — 내부에서 재정렬) */
  regularCaddyPool: AutoAssignCaddy[];
  events: ReservationChangeEvent[];
}): RegularReflowResult {
  const previous = input.previous;
  const date = previous.date;
  const lockedCaddies = protectedCaddyIds(previous);
  const lockedResKeys = protectedReservationKeys(previous);

  let cancelCount = 0;
  let addCount = 0;

  // 일반 예약 시드: 기존 일반 배치 + 일반 미배치(special 키 제외)
  const seedMap = new Map<string, AutoAssignReservation>();
  for (const a of previous.regularAssignments) {
    const key = reservationKey(a.reservation);
    if (!lockedResKeys.has(key)) seedMap.set(key, a.reservation);
  }
  for (const u of previous.unassignedReservations) {
    const key = reservationKey(u.reservation);
    if (lockedResKeys.has(key)) continue;
    if (!seedMap.has(key)) seedMap.set(key, u.reservation);
  }

  for (const event of input.events || []) {
    if (event.type === "CANCEL_RESERVATION") {
      cancelCount += 1;
      const keysToDelete: string[] = [];
      for (const [key, res] of seedMap.entries()) {
        if (matchesCancelEvent(res, event)) keysToDelete.push(key);
      }
      // special 예약 캔슬: 일반 풀에 없어도 OK — 캐디는 locked 유지
      for (const key of keysToDelete) {
        if (lockedResKeys.has(key)) continue;
        seedMap.delete(key);
      }
      continue;
    }
    if (event.type === "ADD_RESERVATION") {
      addCount += 1;
      const res = event.reservation.date
        ? event.reservation
        : { ...event.reservation, date };
      const key = reservationKey(res);
      if (lockedResKeys.has(key)) continue; // special 슬롯 침범 금지
      seedMap.set(key, res);
    }
  }

  const regularReservations = [...seedMap.values()].sort(compareReservationOrder);

  const pool = dedupeCaddies([...(input.regularCaddyPool || [])])
    .filter((c) => !lockedCaddies.has(c.id))
    .sort(compareCaddyOrder);
  const pools = splitCaddyPools(pool);

  const reasonCode =
    cancelCount > 0 && addCount > 0
      ? REASON.REGULAR_MIXED_REFLOW
      : addCount > 0
        ? REASON.REGULAR_ADD_REFLOW
        : REASON.REGULAR_CANCEL_REFLOW;

  const regular = assignRegularSequence({
    date,
    house: pools.house,
    third: pools.third,
    reservations: regularReservations,
    reasonCode,
  });

  const specialRows = specialAssignmentRows(previous);
  const byShift = emptyShiftMeta();
  for (const shift of SHIFT_PARTS) {
    const specialCount = specialRows.filter((a) => a.shift === shift).length;
    byShift[shift].reservations =
      specialCount + regular.byShift[shift].reservations;
    byShift[shift].assigned = specialCount + regular.byShift[shift].assigned;
    byShift[shift].unassigned = regular.byShift[shift].unassigned;
  }

  const usedRegular = new Set(regular.assignments.map((a) => a.caddy.id));
  const unusedCaddies = pool.filter((c) => !usedRegular.has(c.id));

  const assignments = [...specialRows, ...regular.assignments].sort(
    compareAssignmentOrder
  );

  const after: AutoAssignResultV1 = {
    ...previous,
    assignments,
    regularAssignments: regular.assignments,
    unassignedReservations: regular.unassignedReservations,
    closedCourseReservations: previous.closedCourseReservations || [],
    openCourses: previous.openCourses || [...COURSE_ORDER],
    unusedCaddies,
    sparesByShift: regular.sparesByShift,
    meta: {
      ...previous.meta,
      availableCount: pool.length,
      reservationCount:
        specialRows.length + regularReservations.length,
      assignedCount: assignments.length,
      unassignedCount: regular.unassignedReservations.length,
      closedCourseCount: (previous.closedCourseReservations || []).length,
      unusedCount: unusedCaddies.length,
      housePoolCount: pools.house.length,
      thirdPoolCount: pools.third.length,
      drivingPoolCount: pools.driving.length,
      byShift,
      finalPointer: regular.finalPointer,
    },
  };

  const beforeMap = orderIndexMap(previous.regularAssignments);
  const afterMap = orderIndexMap(regular.assignments);
  const caddyIds = new Set<number>([
    ...beforeMap.keys(),
    ...afterMap.keys(),
  ]);

  const changes: ReflowCaddyChange[] = [];
  for (const id of caddyIds) {
    const before = beforeMap.get(id);
    const afterRow = afterMap.get(id);
    const caddy =
      afterRow?.reservation && regular.assignments.find((a) => a.caddy.id === id)
        ?.caddy ||
      previous.regularAssignments.find((a) => a.caddy.id === id)?.caddy ||
      pool.find((c) => c.id === id);
    if (!caddy) continue;

    if (before && afterRow) {
      const sameRes =
        reservationKey(before.reservation) ===
        reservationKey(afterRow.reservation);
      let kind: ReflowChangeKind = "unchanged";
      if (sameRes) {
        kind = "unchanged";
      } else {
        // 더 이른 티/부 → 당김(forward), 더 늦은 티/부 → 밀림(backward)
        const cmp = compareReservationOrder(
          afterRow.reservation,
          before.reservation
        );
        kind = cmp < 0 ? "movedForward" : "movedBackward";
      }
      changes.push({
        caddy,
        kind,
        beforeReservation: before.reservation,
        afterReservation: afterRow.reservation,
        beforeOrderIndex: before.index,
        afterOrderIndex: afterRow.index,
      });
    } else if (!before && afterRow) {
      changes.push({
        caddy,
        kind: "newlyAssigned",
        beforeReservation: null,
        afterReservation: afterRow.reservation,
        beforeOrderIndex: null,
        afterOrderIndex: afterRow.index,
      });
    } else if (before && !afterRow) {
      changes.push({
        caddy,
        kind: "becameUnassigned",
        beforeReservation: before.reservation,
        afterReservation: null,
        beforeOrderIndex: before.index,
        afterOrderIndex: null,
      });
    }
  }

  const summary = {
    movedBackward: changes.filter((c) => c.kind === "movedBackward").length,
    movedForward: changes.filter((c) => c.kind === "movedForward").length,
    unchanged: changes.filter((c) => c.kind === "unchanged").length,
    newlyAssigned: changes.filter((c) => c.kind === "newlyAssigned").length,
    becameUnassigned: changes.filter((c) => c.kind === "becameUnassigned").length,
    specialPreserved: specialRows.length,
  };

  return {
    date,
    reason: reasonCode,
    before: previous,
    after,
    changes,
    summary,
  };
}
