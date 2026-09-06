/**
 * 자동배치 엔진 (3~8단계)
 * - 순수 함수: DB write 없음
 * - 우선순위: 고정/특별찾근 → 54홀 → 1·3부 → 1·2부 → 일반 순번
 * - 일반: HOUSE 순번 + 부별 스페어1·2
 * - 3부: Mode A(원번 미완주) 2부 스페어 HOUSE → 1·3 → WEEKEND(토/일/공휴일만) → regular THIRD
 *        Mode B(원번 완주) 1·3 → WEEKEND(토/일/공휴일만) → regular THIRD
 *        thirdBandSubgroup=WEEKEND는 평일(비공휴일) 3부 어디에든 넣지 않음
 * - DRIVING은 일반 HOUSE/THIRD 순번에 섞지 않음
 * - 8단계: 일반 예약 캔슬/추가 시 regular reflow (special 보호, 스페어·3부 재계산)
 */

import { PRIMARY_TEAMS, isThirdBandTeam } from "@/lib/caddyManage";
import { isWeekendBandPriorityDate } from "@/lib/krHolidays";
import {
  COURSE_CODES,
  COURSE_LABELS,
  normalizeCourse,
  parseTeeTime,
  SHIFT_PARTS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";
import {
  extractWeekendBandInRotationOrder,
  resolveThirdStartTeam,
  rotateThirdQueueFromStartCaddy,
  rotateThirdQueueFromStartTeam,
  automaticThirdStartTeam,
} from "@/lib/thirdWeeklyRotation";
import {
  ensureReservationUid,
  legacyCompositeReservationKey,
  reservationKey as identityReservationKey,
  reservationMatchesIdentity,
} from "@/lib/reservationIdentity";
import {
  SPECIAL_WINDOW_COLLISION,
  SPECIAL_WINDOW_OVERFLOW,
  computeShift1SpecialWindow,
  inferComputePlacementMode,
  parseProtectedTailCount,
  PROTECTED_TAIL_COUNT_DEFAULT,
  type SpecialPlacementMode,
  type SpecialWindowCollision,
} from "@/lib/specialPlacement";
import {
  emptySpecialSupportByShift,
  filterSupportQueueForShift,
  isReservedSupportTailSlot,
  pickNextSpecialSupport,
  specialSupportCaddyIds,
  unusedSupportCount,
} from "@/lib/dailySpecialSupport";

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
  ONE_THREE_MISSING_ANCHOR: "ONE_THREE_MISSING_ANCHOR",
  ONE_TWO_PRIORITY: "ONE_TWO_PRIORITY",
  ONE_TWO_NO_PAIR: "ONE_TWO_NO_COMPATIBLE_PAIR",
  ONE_TWO_MISSING_SHIFT1: "ONE_TWO_MISSING_SHIFT1",
  ONE_TWO_MISSING_SHIFT2: "ONE_TWO_MISSING_SHIFT2",
  ONE_TWO_INSUFFICIENT_RESERVATIONS: "ONE_TWO_INSUFFICIENT_RESERVATIONS",
  ONE_MAK_PRIORITY: "ONE_MAK_PRIORITY",
  ONE_MAK_MISSING_ANCHOR: "ONE_MAK_MISSING_ANCHOR",
  ONE_MAK_INSUFFICIENT_RESERVATIONS: "ONE_MAK_INSUFFICIENT_RESERVATIONS",
  SPECIAL_WINDOW_OVERFLOW,
  SPECIAL_WINDOW_COLLISION,
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
  TEAM_NOSHOW_REFLOW: "TEAM_NOSHOW_REFLOW",
  REGULAR_ADD_REFLOW: "REGULAR_ADD_REFLOW",
  REGULAR_MIXED_REFLOW: "REGULAR_MIXED_REFLOW",
  CADDY_UNAVAILABLE_REFLOW: "CADDY_UNAVAILABLE_REFLOW",
  CADDY_SWAP: "CADDY_SWAP",
  LIMOUSINE_SET: "LIMOUSINE_SET",
  DRIVING_ASSIGN: "DRIVING_ASSIGN",
  DRIVING_CLEAR: "DRIVING_CLEAR",
  LOCK_SET: "LOCK_SET",
  RESERVATION_MOVE_REFLOW: "RESERVATION_MOVE_REFLOW",
  CLOSED_COURSE: "CLOSED_COURSE",
  WEEKEND_BAND_PRIORITY: "WEEKEND_BAND_PRIORITY",
  SPECIAL_SUPPORT: "SPECIAL_SUPPORT",
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
  employmentStatus?: string;
  /** 3부반 주중/주말. WEEKEND는 토·일·공휴일 3부 우선, 평일 비공휴일 3부 제외 */
  thirdBandSubgroup?: string | null;
  /**
   * 관리자 특수근무 입력 순서 (같은 유형 내부 우선순위).
   * 있으면 조순/이름순 대신 이 값을 사용한다.
   */
  inputOrder?: number;
};

export type AutoAssignReservation = {
  /** 선택적 안정 식별자 (고정배치 reservationId 매칭용) */
  id?: string | number;
  /**
   * Draft/JSON 안정 identity. 위치(course/shift/teeTime)에 의존하지 않는다.
   * reservationKey는 id가 없으면 `uid:<uid>` 를 쓴다.
   */
  uid?: string;
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
  /** 리무진카트 요청팀. 캐디가 아니라 예약 속성. */
  limousineCart?: boolean;
};

/** 1부 특수근무(54홀/1·2)가 건너뛰는 앞자리 수 — 코스명 하드코딩 없음 */
export const SHIFT1_PROTECTED_COUNT = 2;

export type SpecialStartAnchor = {
  course: string;
  teeTime: string;
};

export type AssignmentKind =
  | "regular"
  | "fiftyFourHole"
  | "oneThree"
  | "oneTwo"
  | "oneMak"
  | "fixed"
  | "driving"
  | "specialSupport";

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
  /**
   * 특수배치 LOCK. true면 해당 reservation에 고정되어 일반 reflow에 참여하지 않음.
   * 미지정 시 기본값: 특수 kind=ON, 일반=OFF.
   * 1부 ONE_THREE/ONE_MAK은 AUTO 재계산 대상이라 기본 OFF.
   * MANUAL·SET_LOCK·FIXED는 locked=true를 명시한다.
   * 3부 1·3·주말반은 기본 LOCK로 표시되지만 cancel/add reflow에서는
   * 명시적 locked=true가 아니면 3부 우선순위로 재배치한다.
   */
  locked?: boolean;
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

export type UnavailableFromShiftRow = {
  caddyId: number;
  effectiveFromShift: ShiftPart;
};

export type AutoAssignResultV1 = {
  date: string;
  /** 전체 배치 (고정/찾근 + 54홀 + 1·3부 + 1·2부 + 일반) */
  assignments: AutoAssignmentRow[];
  fixedAssignments: AutoAssignmentRow[];
  fiftyFourHoleAssignments: AutoAssignmentRow[];
  oneThreeAssignments: AutoAssignmentRow[];
  oneTwoAssignments: AutoAssignmentRow[];
  oneMakAssignments: AutoAssignmentRow[];
  /** 토/일/공휴일 주말반 3부 (kind=regular). 1·3 다음, regular THIRD 앞 */
  weekendBandAssignments: AutoAssignmentRow[];
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
  /** 부별 특수지원 큐. 정상 HOUSE/THIRD 순번과 분리. 해당 부 capacity 안에 포함. */
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
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
    oneMakCandidateCount: number;
    oneMakAssignedCaddyCount: number;
    oneMakUnassignedCount: number;
    housePoolCount: number;
    thirdPoolCount: number;
    drivingPoolCount: number;
    byShift: Record<
      ShiftPart,
      { reservations: number; assigned: number; unassigned: number }
    >;
    finalPointer: number;
    /** 오늘 1부 첫 캐디 (입력된 경우만) */
    houseStartCaddyId?: number;
    /** 오늘 3부 regular 첫 캐디 (Preview에서 고른 값, 입력된 경우만) */
    thirdStartCaddyId?: number;
    /** 이번 주 3부반 시작조 (자동 또는 해당 주 override) */
    thirdStartTeam: string;
    /** 기준점(2026-08-17=12조)으로 계산한 자동 시작조 */
    thirdStartTeamAutomatic: string;
  };
  /** 1·3부/1막 1부 위치 정책. live reflow가 이 값을 따른다. */
  specialPlacement?: SpecialPlacementState;
  /** 이미 병가/결근 처리된 캐디. 이후 MOVE/reflow가 다시 넣으면 안 된다. */
  unavailableCaddyIds?: number[];
  /** 병가 유효 시작 부. 없으면 unavailableCaddyIds는 종일(1부)로 해석. */
  unavailableFromShift?: UnavailableFromShiftRow[];
};

export type SpecialPlacementState = {
  mode: SpecialPlacementMode;
  protectedTailCount: number;
  window?: {
    N: number;
    specialStart: number;
    specialEnd: number;
    oneThreeStart: number | null;
    oneThreeEnd: number | null;
    oneMakStart: number | null;
    oneMakEnd: number | null;
  };
  block?: SpecialWindowBlock;
};

export type SpecialWindowBlock = {
  code: typeof SPECIAL_WINDOW_OVERFLOW | typeof SPECIAL_WINDOW_COLLISION;
  message: string;
  neededCount: number;
  availableCount: number;
  collisions: SpecialWindowCollision[];
};

export type ReservationCancelCause = "CANCEL" | "TEAM_NOSHOW";
export type CaddyUnavailableCause = "SICK" | "ATTENDANCE_NOSHOW";

export type ReservationChangeEvent =
  | {
      type: "CANCEL_RESERVATION";
      /** V1: CANCEL과 TEAM_NOSHOW는 동일 밀림 reflow, 사유만 구분 */
      cause?: ReservationCancelCause;
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
    }
  | {
      type: "REMOVE_CADDY";
      caddyId: number;
      cause: CaddyUnavailableCause;
      note?: string | null;
      /** 병가 적용 시작 부. 없으면 1부(종일). */
      fromShift?: ShiftPart;
    }
  | {
      type: "SWAP_CADDY";
      reservationKeyA: string;
      reservationKeyB: string;
    }
  | {
      type: "SET_LIMOUSINE";
      reservationKey?: string;
      reservationId?: string | number;
      limousineCart: boolean;
    }
  | {
      type: "ASSIGN_DRIVING";
      reservationKey: string;
      caddyId: number;
    }
  | {
      type: "CLEAR_DRIVING";
      reservationKey: string;
    }
  | {
      type: "SET_LOCK";
      reservationKey: string;
      locked: boolean;
    }
  | {
      type: "MOVE_RESERVATION";
      reservationId?: string | number;
      reservationKey?: string;
      to: {
        course: string;
        shift: string;
        teeTime: string;
        date?: string;
      };
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

export type ReflowWarning = {
  level: "error" | "warn";
  code: string;
  message: string;
  reservationKey?: string;
  caddyId?: number;
};

export type PlacementDiff = {
  reservationKey: string;
  reservation: AutoAssignReservation;
  beforeCaddy: AutoAssignCaddy | null;
  afterCaddy: AutoAssignCaddy | null;
  lockedPreserved: boolean;
};

export type LockedPreservedRow = {
  reservationKey: string;
  caddy: AutoAssignCaddy;
  kind: AssignmentKind;
  reason: string;
};

export type RegularReflowResult = {
  date: string;
  reason: string;
  before: AutoAssignResultV1;
  after: AutoAssignResultV1;
  changes: ReflowCaddyChange[];
  placementDiffs: PlacementDiff[];
  lockedPreserved: LockedPreservedRow[];
  warnings: ReflowWarning[];
  unavailableCaddyIds: number[];
  summary: {
    movedBackward: number;
    movedForward: number;
    unchanged: number;
    newlyAssigned: number;
    becameUnassigned: number;
    specialPreserved: number;
    pulledCount: number;
    pushedCount: number;
    lockedPreservedCount: number;
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

/** 같은 특수유형 내부: 관리자 inputOrder 보존, 없으면 기존 조순 */
export function compareSpecialCandidateOrder(
  a: AutoAssignCaddy,
  b: AutoAssignCaddy
): number {
  const ao = a.inputOrder;
  const bo = b.inputOrder;
  const hasA = typeof ao === "number" && Number.isFinite(ao);
  const hasB = typeof bo === "number" && Number.isFinite(bo);
  if (hasA && hasB) {
    const d = (ao as number) - (bo as number);
    if (d !== 0) return d;
    return a.id - b.id;
  }
  return compareCaddyOrder(a, b);
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

function withoutDrivingCaddies(caddies: AutoAssignCaddy[]): AutoAssignCaddy[] {
  return caddies.filter(
    (c) => normalizeAssignCaddyType(c.caddyType) !== "DRIVING"
  );
}

/**
 * 오늘 1부 첫 캐디 후보: 1~8조 HOUSE만.
 * 9~12조는 caddyType이 HOUSE여도 제외.
 */
export function isHouseStartCandidate(c: {
  team?: string | null;
  caddyType?: string | null;
}): boolean {
  if (isThirdBandTeam(String(c.team ?? ""))) return false;
  const t = String(c.caddyType || "HOUSE").trim().toUpperCase();
  return t === "HOUSE" || t === "";
}

/** 일반 순번용 타입별 풀 분리 (정렬 포함). DRIVING은 조와 무관하게 HOUSE/THIRD에 섞지 않음. */
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
    if (t === "DRIVING") {
      driving.push(c);
      continue;
    }
    // 9~12조는 caddyType과 무관하게 HOUSE 순환에 넣지 않음
    if (isThirdBandTeam(c.team) || t === "THIRD") {
      third.push(c);
      continue;
    }
    house.push(c);
  }
  house.sort(compareCaddyOrder);
  third.sort(compareCaddyOrder);
  driving.sort(compareCaddyOrder);
  return { house, third, driving };
}

/** Same partition as splitCaddyPools, but keep the caller’s relative order. */
function splitCaddyPoolsPreservingOrder(caddies: AutoAssignCaddy[]): {
  house: AutoAssignCaddy[];
  third: AutoAssignCaddy[];
  driving: AutoAssignCaddy[];
} {
  const house: AutoAssignCaddy[] = [];
  const third: AutoAssignCaddy[] = [];
  const driving: AutoAssignCaddy[] = [];
  for (const c of dedupeCaddies(caddies || [])) {
    const t = normalizeAssignCaddyType(c.caddyType);
    if (t === "DRIVING") {
      driving.push(c);
      continue;
    }
    if (isThirdBandTeam(c.team) || t === "THIRD") {
      third.push(c);
      continue;
    }
    house.push(c);
  }
  return { house, third, driving };
}

/**
 * 오늘 1부 첫 캐디 검증 실패 — 자동으로 다음 캐디로 대체하지 않음.
 */
export function parseAssignShiftPart(raw: unknown): ShiftPart | null {
  const s = String(raw ?? "").trim();
  if (s === "1" || s === "1부") return "1부";
  if (s === "2" || s === "2부") return "2부";
  if (s === "3" || s === "3부") return "3부";
  return null;
}

/** 일반 reflow 후보: 재직만. RETIRED/LEAVE는 넣지 않는다. 미지정은 기존 테스트 호환으로 ACTIVE. */
export function eligibleRegularReflowCaddies(
  caddies: readonly AutoAssignCaddy[]
): AutoAssignCaddy[] {
  return dedupeCaddies([...(caddies || [])]).filter((c) => {
    if (!(c.id > 0) || !c.name) return false;
    return isActiveEmploymentStatus(c.employmentStatus ?? "ACTIVE");
  });
}

export function regularCaddyPoolFromAvailabilityRows(
  rows: Array<{
    id: number;
    name: string;
    team: string;
    teamOrder?: number;
    caddyType?: string;
    extraFlags?: string[] | null;
    employmentStatus?: string;
    thirdBandSubgroup?: string | null;
  }>
): AutoAssignCaddy[] {
  return eligibleRegularReflowCaddies(
    (rows || []).map((row) => ({
      id: row.id,
      name: row.name,
      team: row.team,
      teamOrder: Number(row.teamOrder) || 0,
      caddyType: row.caddyType,
      extraFlags: row.extraFlags ?? null,
      employmentStatus: row.employmentStatus,
      thirdBandSubgroup: row.thirdBandSubgroup ?? null,
    }))
  );
}

export class HouseStartCaddyError extends Error {
  status = 400;
  code = "house_start_caddy_invalid";
  constructor(message: string) {
    super(message);
    this.name = "HouseStartCaddyError";
  }
}

/** 오늘 3부 첫 캐디 id 형식/대상 검증 실패. 당일 불가는 에러가 아니라 다음 가용으로 스킵. */
export class ThirdStartCaddyError extends Error {
  status = 400;
  code = "third_start_caddy_invalid";
  constructor(message: string) {
    super(message);
    this.name = "ThirdStartCaddyError";
  }
}

/** Preview form/JSON optional id. 빈 값=null, 비정수=throw. */
export function parseOptionalThirdStartCaddyId(raw: unknown): number | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ThirdStartCaddyError(
      "오늘 3부 첫 캐디(id)가 올바르지 않습니다."
    );
  }
  return n;
}

function isDrivingCaddyType(value: unknown): boolean {
  return String(value ?? "").trim().toUpperCase() === "DRIVING";
}

function assertThirdStartCaddy(
  startCaddyId: number,
  known: readonly AutoAssignCaddy[]
): AutoAssignCaddy {
  const found = known.find((caddy) => caddy.id === startCaddyId);
  if (!found) {
    throw new ThirdStartCaddyError(
      `선택한 3부 첫 캐디(id=${startCaddyId})를 찾을 수 없습니다.`
    );
  }
  if (!isThirdBandTeam(found.team) || isDrivingCaddyType(found.caddyType)) {
    throw new ThirdStartCaddyError(
      `선택한 3부 첫 캐디(id=${startCaddyId})는 9~12조 THIRD가 아닙니다.`
    );
  }
  return found;
}

/**
 * 정렬된 HOUSE 큐에서 startCaddyId를 찾아
 * [선택 → 뒤 → 끝 → 처음 → 선택 직전] 순환 순서로 재배열.
 * teamOrder 필드 값은 수정하지 않음 (참조 객체 그대로).
 */
export function rotateHouseQueueFromStart(
  sortedHouse: AutoAssignCaddy[],
  startCaddyId: number
): AutoAssignCaddy[] {
  if (!Number.isInteger(startCaddyId) || startCaddyId < 1) {
    throw new HouseStartCaddyError(
      "오늘 1부 첫 캐디(id)가 올바르지 않습니다."
    );
  }
  const idx = sortedHouse.findIndex((c) => c.id === startCaddyId);
  if (idx < 0) {
    throw new HouseStartCaddyError(
      `선택한 1부 첫 캐디(id=${startCaddyId})는 당일 일반 HOUSE 가용 풀에 없습니다. 다시 선택해주세요.`
    );
  }
  if (idx === 0) return sortedHouse;
  return [...sortedHouse.slice(idx), ...sortedHouse.slice(0, idx)];
}

/**
 * 오늘 1부 첫 캐디가 특수근무(1막/1·2/1·3/54홀/고정)로 일반 HOUSE에서
 * 빠진 경우, 원본 HOUSE를 회전한 뒤 특수 제외 id만 빼고 일반 순번을 이어간다.
 * 처음부터 HOUSE 가용 풀에 없던 시작점은 기존처럼 HouseStartCaddyError.
 */
export function resolveRegularHouseQueue(input: {
  originalHouse: AutoAssignCaddy[];
  remainingHouse: AutoAssignCaddy[];
  specialExcludeIds: Iterable<number>;
  houseStartCaddyId?: number | null;
}): { house: AutoAssignCaddy[]; houseStartCaddyId: number | null } {
  const remaining = [...input.remainingHouse];
  const startRaw = input.houseStartCaddyId;
  if (startRaw == null || startRaw === undefined) {
    return { house: remaining, houseStartCaddyId: null };
  }
  const startId = Number(startRaw);
  const original = [...input.originalHouse];
  const inOriginal = original.some((caddy) => caddy.id === startId);
  if (!inOriginal) {
    rotateHouseQueueFromStart(remaining, startId);
    return { house: remaining, houseStartCaddyId: startId };
  }
  const exclude = new Set([...input.specialExcludeIds].map(Number));
  if (exclude.has(startId)) {
    const rotated = rotateHouseQueueFromStart(original, startId);
    return {
      house: rotated.filter((caddy) => !exclude.has(caddy.id)),
      houseStartCaddyId: null,
    };
  }
  return { house: remaining, houseStartCaddyId: startId };
}

/**
 * Reflow용 HOUSE 큐. 시작 캐디가 병가/결근으로 remaining에서 빠져도
 * 원래 회전 기준은 유지하고 그 캐디만 건너뛴다.
 * assignRegularSequence에 넘길 house는 이미 회전됐을 수 있으므로
 * 그 경우 houseStartCaddyId는 null(재회전 금지).
 */
export function resolveHouseQueueKeepingOrigin(input: {
  remainingHouse: AutoAssignCaddy[];
  originalHouse: AutoAssignCaddy[];
  houseStartCaddyId?: number | null;
}): { house: AutoAssignCaddy[]; houseStartCaddyId: number | null } {
  const remaining = [...input.remainingHouse];
  const startRaw = input.houseStartCaddyId;
  if (startRaw == null || startRaw === undefined) {
    return { house: remaining, houseStartCaddyId: null };
  }
  const startId = Number(startRaw);
  if (!Number.isInteger(startId) || startId < 1) {
    return { house: remaining, houseStartCaddyId: null };
  }
  if (remaining.some((caddy) => caddy.id === startId)) {
    return { house: remaining, houseStartCaddyId: startId };
  }
  const original = [...input.originalHouse];
  if (!original.some((caddy) => caddy.id === startId)) {
    return { house: remaining, houseStartCaddyId: null };
  }
  const remainingIds = new Set(remaining.map((caddy) => caddy.id));
  const rotated = rotateHouseQueueFromStart(original, startId);
  return {
    house: rotated.filter((caddy) => remainingIds.has(caddy.id)),
    houseStartCaddyId: null,
  };
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

/**
 * 순환 sequence 기준 Spare1·2.
 * startIdx부터 wrap하며, 같은 부 실배치(usedInShift)는 건너뜀.
 * 1·2부는 HOUSE 큐, 3부는 당일 3부 최종 배치 sequence에 사용.
 * 풀이 부족하면 남은 자리는 null.
 */
export function pickCircularHouseSpares(
  house: AutoAssignCaddy[],
  startIdx: number,
  usedInShift: ReadonlySet<number>
): { spare1: SpareCaddyInfo | null; spare2: SpareCaddyInfo | null } {
  if (house.length === 0) {
    return { spare1: null, spare2: null };
  }
  const origin =
    ((startIdx % house.length) + house.length) % house.length;
  const picked: AutoAssignCaddy[] = [];
  for (let attempt = 0; attempt < house.length && picked.length < 2; attempt++) {
    const caddy = house[(origin + attempt) % house.length];
    if (usedInShift.has(caddy.id)) continue;
    picked.push(caddy);
  }
  return {
    spare1: toSpareInfo(picked[0] ?? null),
    spare2: toSpareInfo(picked[1] ?? null),
  };
}

function emptySparesByShift(): SpareByShift[] {
  return SHIFT_PARTS.map((shift) => ({
    shift,
    spare1: null,
    spare2: null,
  }));
}

/** 2부 스페어 표시값(sparesByShift["2부"])을 HOUSE 객체로. 최대 2명. */
export function shift2SpareCaddiesFromSpares(
  house: AutoAssignCaddy[],
  sparesByShift: SpareByShift[]
): AutoAssignCaddy[] {
  const row = sparesByShift.find((s) => s.shift === "2부");
  if (!row) return [];
  const houseById = new Map(house.map((c) => [c.id, c]));
  const out: AutoAssignCaddy[] = [];
  const seen = new Set<number>();
  for (const info of [row.spare1, row.spare2]) {
    if (!info) continue;
    if (seen.has(info.caddyId)) continue;
    const caddy = houseById.get(info.caddyId);
    if (!caddy) continue;
    seen.add(caddy.id);
    out.push(caddy);
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
  return identityReservationKey(r);
}

function shiftReservations(
  reservations: AutoAssignReservation[],
  shift: ShiftPart
): AutoAssignReservation[] {
  return reservations
    .filter((r) => r.shift === shift)
    .sort(compareReservationOrder);
}

function withoutTaken(
  reservations: AutoAssignReservation[],
  taken: AutoAssignReservation[]
): AutoAssignReservation[] {
  const keys = new Set(taken.map(reservationKey));
  return reservations.filter((r) => !keys.has(reservationKey(r)));
}

export function matchSpecialAnchor(
  reservation: AutoAssignReservation,
  anchor: SpecialStartAnchor
): boolean {
  const have = resolveCourseCode(reservation.course);
  const want = resolveCourseCode(anchor.course);
  if (have && want) {
    if (have !== want) return false;
  } else if (String(reservation.course).trim() !== String(anchor.course).trim()) {
    return false;
  }
  return reservation.teeTime === anchor.teeTime;
}

function protectedShift1KeySet(
  shift1: AutoAssignReservation[]
): Set<string> {
  return new Set(
    shift1.slice(0, SHIFT1_PROTECTED_COUNT).map((row) => reservationKey(row))
  );
}

function openShift1Window(
  remaining: AutoAssignReservation[],
  protectedKeys: ReadonlySet<string>
): AutoAssignReservation[] {
  return shiftReservations(remaining, "1부").filter(
    (row) => !protectedKeys.has(reservationKey(row))
  );
}

function reservationsFromAnchor(
  remainingShiftRows: AutoAssignReservation[],
  originalShiftRows: AutoAssignReservation[],
  anchor: SpecialStartAnchor
): { found: boolean; rows: AutoAssignReservation[] } {
  const origIdx = originalShiftRows.findIndex((row) =>
    matchSpecialAnchor(row, anchor)
  );
  if (origIdx < 0) return { found: false, rows: [] };
  const afterKeys = new Set(
    originalShiftRows.slice(origIdx).map((row) => reservationKey(row))
  );
  return {
    found: true,
    rows: remainingShiftRows.filter((row) => afterKeys.has(reservationKey(row))),
  };
}

function occupancyLookup(
  rows: AutoAssignmentRow[]
): Map<string, { kind: string; reason: string }> {
  const map = new Map<string, { kind: string; reason: string }>();
  for (const row of rows) {
    map.set(reservationKey(row.reservation), {
      kind: row.kind,
      reason: row.reason,
    });
  }
  return map;
}

function blockAllSpecialCandidates(
  bag: SpecialUnassignedRow[],
  caddies: AutoAssignCaddy[],
  reason: string
) {
  for (const caddy of caddies) {
    bag.push({ caddy, reason, review: true });
  }
}

function findLaterWithGap(
  first: AutoAssignReservation,
  remaining: AutoAssignReservation[],
  minGapMinutes: number
): AutoAssignReservation | null {
  const t1 = reservationInstantMinutes(first);
  if (!Number.isFinite(t1)) return null;
  const later: AutoAssignReservation[] = [];
  for (const row of remaining) {
    const t2 = reservationInstantMinutes(row);
    if (!Number.isFinite(t2)) continue;
    if (t2 - t1 >= minGapMinutes) later.push(row);
  }
  later.sort(compareReservationOrder);
  return later[0] || null;
}

/**
 * 3부 remaining 예약 정렬만. 주말반 캐디 우선은 assignRegularSequence 3부 queue에서 처리.
 */
export function applyWeekendBandPriorityIfPresent(
  shift3: AutoAssignReservation[]
): AutoAssignReservation[] {
  return [...shift3].sort(compareReservationOrder);
}

export type SpecialDutySlotResult = {
  fiftyFourHoleAssignments: AutoAssignmentRow[];
  oneTwoAssignments: AutoAssignmentRow[];
  oneThreeAssignments: AutoAssignmentRow[];
  oneMakAssignments: AutoAssignmentRow[];
  weekendBandAssignments: AutoAssignmentRow[];
  specialUnassigned: SpecialUnassignedRow[];
  remainingReservations: AutoAssignReservation[];
  assignedCaddyIds: Set<number>;
  /** 1부 1·3 배치에 성공한 신청자. 3부 우선은 regular 1·2부 이후 */
  oneThreePlaced: AutoAssignCaddy[];
  specialPlacement: SpecialPlacementState;
};

/**
 * 관리자 특수근무 슬롯 배치 (고정/찾근 이후).
 * 1부: 앞 2자리 보호 → 54홀 → 1·2부, 1·3/1막은 AUTO 순번 창 또는 MANUAL anchor.
 * 2부: HOUSE 첫근무 순환이 끝나는 지점에 1·2부 삽입.
 * 3부 1·3·WEEKEND는 여기가 아니라 regular 1·2부·2부 스페어 이후 배치.
 */
export function assignSpecialDutySlots(input: {
  date: string;
  reservations: AutoAssignReservation[];
  fiftyFourHole: AutoAssignCaddy[];
  oneTwoCandidates: AutoAssignCaddy[];
  oneThreeCandidates: AutoAssignCaddy[];
  oneMakCandidates: AutoAssignCaddy[];
  placementMode?: SpecialPlacementMode | null;
  protectedTailCount?: number;
  occupiedReservations?: AutoAssignmentRow[];
  oneThreeAnchor?: SpecialStartAnchor | null;
  oneMakAnchor?: SpecialStartAnchor | null;
  /** 고정 제외 전 1부 실제 sequence. 없으면 remaining으로 계산 */
  originalShift1?: AutoAssignReservation[];
  protectedShift1Keys?: ReadonlySet<string>;
  housePoolLength: number;
  min54HoleGapMinutes?: number;
}): SpecialDutySlotResult {
  const date = input.date;
  const minGap = input.min54HoleGapMinutes ?? MIN_54HOLE_GAP_MINUTES;
  let remaining = [...input.reservations];
  const fiftyFourHoleAssignments: AutoAssignmentRow[] = [];
  const oneTwoAssignments: AutoAssignmentRow[] = [];
  const oneThreeAssignments: AutoAssignmentRow[] = [];
  const oneMakAssignments: AutoAssignmentRow[] = [];
  const weekendBandAssignments: AutoAssignmentRow[] = [];
  const specialUnassigned: SpecialUnassignedRow[] = [];
  const assignedCaddyIds = new Set<number>();

  const fiftyFour = dedupeCaddies([...input.fiftyFourHole]).sort(
    compareSpecialCandidateOrder
  );
  const oneTwo = dedupeCaddies([...input.oneTwoCandidates]).sort(
    compareSpecialCandidateOrder
  );
  const oneThree = dedupeCaddies([...input.oneThreeCandidates]).sort(
    compareSpecialCandidateOrder
  );
  const oneMak = dedupeCaddies([...input.oneMakCandidates]).sort(
    compareSpecialCandidateOrder
  );
  const originalShift1 = (
    input.originalShift1?.length
      ? [...input.originalShift1]
      : shiftReservations(input.reservations, "1부")
  ).sort(compareReservationOrder);
  const protectedKeys =
    input.protectedShift1Keys ?? protectedShift1KeySet(originalShift1);

  const pushPair = (
    bag: AutoAssignmentRow[],
    caddy: AutoAssignCaddy,
    reservation: AutoAssignReservation,
    reason: string,
    kind: AssignmentKind,
    pairId: string | null
  ) => {
    bag.push({
      date,
      shift: reservation.shift as ShiftPart,
      sequenceIndex: -1,
      reason,
      reservation,
      caddy,
      pairId,
      kind,
    });
  };

  // 54홀: 1부 전체 sequence의 세 번째 자리부터. 다음 근무는 ≥6h
  {
    const window = openShift1Window(remaining, protectedKeys);
    const taken: AutoAssignReservation[] = [];
    let cursor = 0;
    for (const caddy of fiftyFour) {
      if (cursor >= window.length) {
        specialUnassigned.push({
          caddy,
          reason: REASON.FIFTY_FOUR_INSUFFICIENT_RESERVATIONS,
          review: true,
        });
        continue;
      }
      const first = window[cursor++];
      const afterFirst = withoutTaken(remaining, [...taken, first]);
      const second = findLaterWithGap(first, afterFirst, minGap);
      pushPair(
        fiftyFourHoleAssignments,
        caddy,
        first,
        REASON.FIFTY_FOUR_HOLE_PRIORITY,
        "fiftyFourHole",
        second
          ? `54H-${caddy.id}-${first.teeTime}-${second.teeTime}`
          : `54H-${caddy.id}-${first.teeTime}`
      );
      taken.push(first);
      if (second) {
        pushPair(
          fiftyFourHoleAssignments,
          caddy,
          second,
          REASON.FIFTY_FOUR_HOLE_PRIORITY,
          "fiftyFourHole",
          `54H-${caddy.id}-${first.teeTime}-${second.teeTime}`
        );
        taken.push(second);
      } else {
        specialUnassigned.push({
          caddy,
          reason: REASON.FIFTY_FOUR_NO_PAIR,
          review: true,
        });
      }
      assignedCaddyIds.add(caddy.id);
    }
    remaining = withoutTaken(remaining, taken);
  }

  // 1·2부 1부: 보호 2자리 다음, 54홀이 있으면 그 직후 연속
  const oneTwoPlaced: AutoAssignCaddy[] = [];
  {
    const window = openShift1Window(remaining, protectedKeys);
    const taken: AutoAssignReservation[] = [];
    let cursor = 0;
    for (const caddy of oneTwo) {
      if (cursor >= window.length) {
        specialUnassigned.push({
          caddy,
          reason: REASON.ONE_TWO_MISSING_SHIFT1,
          review: true,
        });
        continue;
      }
      const slot = window[cursor++];
      pushPair(
        oneTwoAssignments,
        caddy,
        slot,
        REASON.ONE_TWO_PRIORITY,
        "oneTwo",
        `12-${caddy.id}`
      );
      taken.push(slot);
      oneTwoPlaced.push(caddy);
      assignedCaddyIds.add(caddy.id);
    }
    remaining = withoutTaken(remaining, taken);
  }

  const oneThreePlaced: AutoAssignCaddy[] = [];
  const placementMode = inferComputePlacementMode({
    placementMode: input.placementMode,
    hasAnchor: !!(input.oneThreeAnchor || input.oneMakAnchor),
  });
  const tailParsed = parseProtectedTailCount(
    input.protectedTailCount ?? PROTECTED_TAIL_COUNT_DEFAULT
  );
  const protectedTailCount = tailParsed.ok
    ? tailParsed.value
    : PROTECTED_TAIL_COUNT_DEFAULT;
  let specialPlacement: SpecialPlacementState = {
    mode: placementMode,
    protectedTailCount,
  };

  const lockSpecial = placementMode === "MANUAL";
  const pushShift1Special = (
    bag: AutoAssignmentRow[],
    caddy: AutoAssignCaddy,
    reservation: AutoAssignReservation,
    reason: string,
    kind: AssignmentKind,
    pairId: string | null
  ) => {
    bag.push({
      date,
      shift: reservation.shift as ShiftPart,
      sequenceIndex: -1,
      reason,
      reservation,
      caddy,
      pairId,
      kind,
      locked: lockSpecial,
    });
  };

  if (placementMode === "AUTO") {
    const window = computeShift1SpecialWindow({
      N: originalShift1.length,
      R: protectedTailCount,
      A: oneThree.length,
      B: oneMak.length,
    });
    if (!window.ok) {
      blockAllSpecialCandidates(
        specialUnassigned,
        [...oneThree, ...oneMak],
        REASON.SPECIAL_WINDOW_OVERFLOW
      );
      specialPlacement = {
        mode: "AUTO",
        protectedTailCount,
        block: {
          code: REASON.SPECIAL_WINDOW_OVERFLOW,
          message: window.message,
          neededCount: window.neededCount,
          availableCount: window.availableCount,
          collisions: [],
        },
      };
    } else if (window.neededCount > 0) {
      const occupied = occupancyLookup([
        ...(input.occupiedReservations || []),
        ...fiftyFourHoleAssignments,
        ...oneTwoAssignments,
      ]);
      const remainingKeys = new Set(
        shiftReservations(remaining, "1부").map(reservationKey)
      );
      const collisions: SpecialWindowCollision[] = [];
      const target = originalShift1.slice(
        window.specialStart - 1,
        window.specialEnd
      );
      target.forEach((row, offset) => {
        const key = reservationKey(row);
        if (remainingKeys.has(key)) return;
        const hit = occupied.get(key);
        collisions.push({
          index: window.specialStart + offset,
          course: String(row.course),
          teeTime: row.teeTime,
          teamName: row.teamName ?? null,
          kind: hit?.kind,
          reason: hit?.reason,
        });
      });
      if (collisions.length) {
        blockAllSpecialCandidates(
          specialUnassigned,
          [...oneThree, ...oneMak],
          REASON.SPECIAL_WINDOW_COLLISION
        );
        specialPlacement = {
          mode: "AUTO",
          protectedTailCount,
          window: {
            N: window.N,
            specialStart: window.specialStart,
            specialEnd: window.specialEnd,
            oneThreeStart: window.oneThreeStart,
            oneThreeEnd: window.oneThreeEnd,
            oneMakStart: window.oneMakStart,
            oneMakEnd: window.oneMakEnd,
          },
          block: {
            code: REASON.SPECIAL_WINDOW_COLLISION,
            message: `1·3부/1막 자동 구간에 이미 다른 특수배치가 있습니다 (${collisions
              .map(
                (c) =>
                  `${c.index}번째 ${c.course} ${c.teeTime}${
                    c.kind ? ` · ${c.kind}` : ""
                  }`
              )
              .join(", ")}).`,
            neededCount: window.neededCount,
            availableCount: window.availableCount,
            collisions,
          },
        };
      } else {
        const taken: AutoAssignReservation[] = [];
        oneThree.forEach((caddy, i) => {
          const slot = target[i];
          pushShift1Special(
            oneThreeAssignments,
            caddy,
            slot,
            REASON.ONE_THREE_PRIORITY,
            "oneThree",
            `13-${caddy.id}`
          );
          taken.push(slot);
          oneThreePlaced.push(caddy);
          assignedCaddyIds.add(caddy.id);
        });
        oneMak.forEach((caddy, i) => {
          const slot = target[oneThree.length + i];
          pushShift1Special(
            oneMakAssignments,
            caddy,
            slot,
            REASON.ONE_MAK_PRIORITY,
            "oneMak",
            null
          );
          taken.push(slot);
          assignedCaddyIds.add(caddy.id);
        });
        remaining = withoutTaken(remaining, taken);
        specialPlacement = {
          mode: "AUTO",
          protectedTailCount,
          window: {
            N: window.N,
            specialStart: window.specialStart,
            specialEnd: window.specialEnd,
            oneThreeStart: window.oneThreeStart,
            oneThreeEnd: window.oneThreeEnd,
            oneMakStart: window.oneMakStart,
            oneMakEnd: window.oneMakEnd,
          },
        };
      }
    } else {
      specialPlacement = {
        mode: "AUTO",
        protectedTailCount,
        window: {
          N: window.N,
          specialStart: window.specialStart,
          specialEnd: window.specialEnd,
          oneThreeStart: null,
          oneThreeEnd: null,
          oneMakStart: null,
          oneMakEnd: null,
        },
      };
    }
  } else {
    // MANUAL: 기존 관리자 anchor부터 연속
    if (oneThree.length && !input.oneThreeAnchor) {
      blockAllSpecialCandidates(
        specialUnassigned,
        oneThree,
        REASON.ONE_THREE_MISSING_ANCHOR
      );
    } else if (oneThree.length && input.oneThreeAnchor) {
      const from = reservationsFromAnchor(
        shiftReservations(remaining, "1부"),
        originalShift1,
        input.oneThreeAnchor
      );
      if (!from.found) {
        blockAllSpecialCandidates(
          specialUnassigned,
          oneThree,
          REASON.ONE_THREE_MISSING_ANCHOR
        );
      } else if (!from.rows.length) {
        blockAllSpecialCandidates(
          specialUnassigned,
          oneThree,
          REASON.ONE_THREE_MISSING_SHIFT1
        );
      } else {
        const taken: AutoAssignReservation[] = [];
        let cursor = 0;
        for (const caddy of oneThree) {
          if (cursor >= from.rows.length) {
            specialUnassigned.push({
              caddy,
              reason: REASON.ONE_THREE_INSUFFICIENT_RESERVATIONS,
              review: true,
            });
            continue;
          }
          const slot = from.rows[cursor++];
          pushShift1Special(
            oneThreeAssignments,
            caddy,
            slot,
            REASON.ONE_THREE_PRIORITY,
            "oneThree",
            `13-${caddy.id}`
          );
          taken.push(slot);
          oneThreePlaced.push(caddy);
          assignedCaddyIds.add(caddy.id);
        }
        remaining = withoutTaken(remaining, taken);
      }
    }

    if (oneMak.length && !input.oneMakAnchor) {
      blockAllSpecialCandidates(
        specialUnassigned,
        oneMak,
        REASON.ONE_MAK_MISSING_ANCHOR
      );
    } else if (oneMak.length && input.oneMakAnchor) {
      const from = reservationsFromAnchor(
        shiftReservations(remaining, "1부"),
        originalShift1,
        input.oneMakAnchor
      );
      if (!from.found) {
        blockAllSpecialCandidates(
          specialUnassigned,
          oneMak,
          REASON.ONE_MAK_MISSING_ANCHOR
        );
      } else if (!from.rows.length) {
        blockAllSpecialCandidates(
          specialUnassigned,
          oneMak,
          REASON.ONE_MAK_INSUFFICIENT_RESERVATIONS
        );
      } else {
        const taken: AutoAssignReservation[] = [];
        let cursor = 0;
        for (const caddy of oneMak) {
          if (cursor >= from.rows.length) {
            specialUnassigned.push({
              caddy,
              reason: REASON.ONE_MAK_INSUFFICIENT_RESERVATIONS,
              review: true,
            });
            continue;
          }
          const slot = from.rows[cursor++];
          pushShift1Special(
            oneMakAssignments,
            caddy,
            slot,
            REASON.ONE_MAK_PRIORITY,
            "oneMak",
            null
          );
          taken.push(slot);
          assignedCaddyIds.add(caddy.id);
        }
        remaining = withoutTaken(remaining, taken);
      }
    }
  }

  // 1·2부 2부: HOUSE 첫근무 순환 종료(1부 첫 캐디 투근무 시작 직전)에 삽입
  {
    const shift1Left = shiftReservations(remaining, "1부").length;
    const houseLen = Math.max(0, input.housePoolLength);
    const houseUsedShift1 = Math.min(shift1Left, houseLen);
    const firstWorkOnShift2 = Math.max(0, houseLen - houseUsedShift1);
    const shift2 = shiftReservations(remaining, "2부");
    const insertAt = Math.min(firstWorkOnShift2, shift2.length);
    const taken: AutoAssignReservation[] = [];
    let cursor = insertAt;
    for (const caddy of oneTwoPlaced) {
      if (cursor >= shift2.length) {
        specialUnassigned.push({
          caddy,
          reason: REASON.ONE_TWO_MISSING_SHIFT2,
          review: true,
        });
        continue;
      }
      const slot = shift2[cursor++];
      pushPair(
        oneTwoAssignments,
        caddy,
        slot,
        REASON.ONE_TWO_PRIORITY,
        "oneTwo",
        `12-${caddy.id}`
      );
      taken.push(slot);
    }
    remaining = withoutTaken(remaining, taken);
  }

  return {
    fiftyFourHoleAssignments,
    oneTwoAssignments,
    oneThreeAssignments,
    oneMakAssignments,
    weekendBandAssignments,
    specialUnassigned,
    remainingReservations: remaining.sort(compareReservationOrder),
    assignedCaddyIds,
    oneThreePlaced,
    specialPlacement,
  };
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
  const candidates = dedupeCaddies([...input.fiftyFourHole]).sort(
    compareSpecialCandidateOrder
  );
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
    compareSpecialCandidateOrder
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
    compareSpecialCandidateOrder
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
 * - 3부 (실제 1·2부 배치 결과 기준):
 *   A) HOUSE 원번 잔여(1·2부 미근무 HOUSE 존재):
 *      2부 스페어 HOUSE(최대 2, sparesByShift["2부"]) → 1·3 신청자 → WEEKEND(토/일/공휴일만)
 *      → THIRD(thirdStartCaddyId는 WEEKEND 제외 후 여기부터) → 남은 미근무 HOUSE → (부족 시) 기근무 wrap
 *   B) HOUSE 소진(전원이 1·2부 중 ≥1회 실근무):
 *      1·3 신청자 → WEEKEND(토/일/공휴일만) → THIRD → (1부 미근무 ∩ 2부 실근무) HOUSE, 단 1부 spare1·2 제외
 *      (2부 스페어 우선 없음. 2부 spare 표시/계산은 유지)
 *   WEEKEND(thirdBandSubgroup)는 날짜와 관계없이 regular THIRD에서 먼저 분리한다.
 *   토/일/한국 공휴일에만 weekendBand로 쓰고, 평일 비공휴일은 그날 3부에 배치하지 않는다.
 * - 3부 spare1·2 = 당일 3부 최종 배치 sequence에서 마지막 배치자 다음 가용 2명
 *   (별도 HOUSE queue에서 새로 뽑지 않음. Mode A/B 동일. 순환 시 해당 3부 sequence 유지)
 * - DRIVING은 일반 순번에 섞지 않음
 */
function specialSupportAssignmentRow(input: {
  date: string;
  shift: ShiftPart;
  reservation: AutoAssignReservation;
  caddy: AutoAssignCaddy;
}): AutoAssignmentRow {
  return {
    date: input.date,
    shift: input.shift,
    sequenceIndex: -1,
    reason: REASON.SPECIAL_SUPPORT,
    reservation: input.reservation,
    caddy: input.caddy,
    pairId: null,
    kind: "specialSupport",
    locked: false,
  };
}

export function assignRegularSequence(input: {
  date: string;
  /** 혼합 가용(하위 호환). house/third가 있으면 무시됨 */
  available?: AutoAssignCaddy[];
  house?: AutoAssignCaddy[];
  third?: AutoAssignCaddy[];
  reservations: AutoAssignReservation[];
  reasonCode?: string;
  /**
   * 오늘 1부 첫 HOUSE 캐디 id.
   * 있으면 정렬 후 해당 캐디부터 순환큐 회전. 없으면 현행(start=0).
   * teamOrder 값은 수정하지 않음.
   */
  houseStartCaddyId?: number | null;
  /** 이번 주 3부반 시작조. 미입력 시 날짜 자동 순환 */
  thirdStartTeam?: string | null;
  /** 오늘 3부 regular 첫 캐디. 미입력 시 시작조 첫 가용. 풀에 없으면 다음 가용 */
  thirdStartCaddyId?: number | null;
  /** 9~12조 위치 조회용 (비가용·주말반 제외자 포함). 없으면 third+house로 검증 */
  thirdRoster?: AutoAssignCaddy[] | null;
  /**
   * 1부 1·3 배치에 성공한 신청자만. 3부 2순위(Mode A) / 1순위(Mode B).
   * 1부에 못 들어간 신청자는 넣지 않는다.
   */
  oneThreeForThird?: AutoAssignCaddy[];
  /** 이미 확정된 부 배치. freezeShifts와 함께 이전 부 identity를 유지한다. */
  seedAssignments?: AutoAssignmentRow[];
  /** 이 부는 다시 채우지 않고 seed + 기존 spare를 유지한다. */
  freezeShifts?: ShiftPart[];
  seedSparesByShift?: SpareByShift[];
  /** 캐디가 빠지는 첫 부. 그 부부터 pick/spare에서 건너뛴다. */
  unavailableFromShift?: Map<number, ShiftPart>;
  /**
   * 특수지원 큐. house/third 배열에 넣지 않는다.
   * 해당 부 capacity 꼬리에 넣고, 그 수만큼 정상 HOUSE 소비를 줄인다.
   */
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
  /**
   * 이미 다른 파이프라인(고정/1막/1·2/1·3/54홀)에서 배치된 캐디.
   * usedInShift에만 넣고 이 함수 결과 row로는 다시 내보내지 않는다.
   */
  occupiedAssignments?: AutoAssignmentRow[];
}): {
  assignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  specialUnassigned: SpecialUnassignedRow[];
  finalPointer: number;
  byShift: Record<
    ShiftPart,
    { reservations: number; assigned: number; unassigned: number }
  >;
  sparesByShift: SpareByShift[];
} {
  const supportIds = specialSupportCaddyIds(input.specialSupportByShift);
  const pools =
    input.house != null
      ? {
          house: withoutDrivingCaddies(dedupeCaddies([...(input.house || [])])),
          third: withoutDrivingCaddies(dedupeCaddies([...(input.third || [])])),
          driving: [] as AutoAssignCaddy[],
        }
      : splitCaddyPools(input.available || []);
  pools.house = pools.house.filter((caddy) => !supportIds.has(caddy.id));
  pools.third = pools.third.filter((caddy) => !supportIds.has(caddy.id));

  const house =
    input.houseStartCaddyId != null && input.houseStartCaddyId !== undefined
      ? rotateHouseQueueFromStart(pools.house, Number(input.houseStartCaddyId))
      : pools.house;
  const thirdStartTeam = resolveThirdStartTeam(input.thirdStartTeam, input.date);
  let third = rotateThirdQueueFromStartTeam(pools.third, thirdStartTeam);
  const weekendSeparated = extractWeekendBandInRotationOrder(third);
  const weekendIds = new Set(weekendSeparated.map((c) => c.id));
  third = third.filter((caddy) => !weekendIds.has(caddy.id));
  const weekendBand = isWeekendBandPriorityDate(input.date)
    ? weekendSeparated
    : [];
  const oneThreeForThird = dedupeCaddies([...(input.oneThreeForThird || [])]);
  const thirdStartCaddyId =
    input.thirdStartCaddyId != null && input.thirdStartCaddyId !== undefined
      ? Number(input.thirdStartCaddyId)
      : null;
  if (thirdStartCaddyId != null) {
    const roster = dedupeCaddies([
      ...(input.thirdRoster || []),
      ...pools.third,
      ...pools.house,
      ...pools.driving,
    ]);
    assertThirdStartCaddy(thirdStartCaddyId, roster);
    third = rotateThirdQueueFromStartCaddy(
      third,
      thirdStartCaddyId,
      roster,
      thirdStartTeam
    );
  }
  const houseIndexById = new Map(house.map((c, i) => [c.id, i]));
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
  const specialUnassigned: SpecialUnassignedRow[] = [];
  /** 다음 부가 시작할 HOUSE 절대 인덱스 (스페어1 위치, wrap 없이 누적) */
  let houseStart = 0;
  const sparesByShift: SpareByShift[] = [];
  const freezeSet = new Set(input.freezeShifts || []);
  const seedByShift = new Map<ShiftPart, AutoAssignmentRow[]>();
  for (const row of input.seedAssignments || []) {
    const list = seedByShift.get(row.shift) || [];
    list.push(row);
    seedByShift.set(row.shift, list);
  }
  const seedSpareByShift = new Map(
    (input.seedSparesByShift || []).map((s) => [s.shift, s])
  );
  const unavailableFrom = input.unavailableFromShift || new Map<number, ShiftPart>();
  const specialSupportByShift =
    input.specialSupportByShift || emptySpecialSupportByShift();
  const occupiedByShift = new Map<ShiftPart, number[]>();
  for (const row of input.occupiedAssignments || []) {
    const list = occupiedByShift.get(row.shift) || [];
    list.push(row.caddy.id);
    occupiedByShift.set(row.shift, list);
  }
  const normalPoolIds = new Set<number>([
    ...house.map((c) => c.id),
    ...third.map((c) => c.id),
    ...oneThreeForThird.map((c) => c.id),
    ...weekendBand.map((c) => c.id),
  ]);

  for (const shift of SHIFT_PARTS) {
    const shiftReservations = reservations.filter((r) => r.shift === shift);
    const usedInShift = new Set<number>(occupiedByShift.get(shift) || []);
    let houseAssigned = 0;
    /** 3부 실제 배치 sequence + 다음 인덱스 — spare1/2는 이 연속선상에서만 계산 */
    let thirdSequence: AutoAssignCaddy[] | null = null;
    let thirdNextIdx = 0;

    for (const [caddyId, from] of unavailableFrom.entries()) {
      if (shiftRank(shift) >= shiftRank(from)) usedInShift.add(caddyId);
    }
    const seeded = (seedByShift.get(shift) || []).map(cloneAssignmentRow);
    for (const row of seeded) {
      assignments.push(row);
      usedInShift.add(row.caddy.id);
      // Cursor follows regular HOUSE consume only. 1막/1·2/1·3/54홀/fixed
      // are non-consumers even if they are seeded on a frozen shift.
      if (row.kind === "regular" && isHouseRegularCaddy(row.caddy)) {
        houseAssigned += 1;
      }
      byShift[shift].assigned += 1;
    }
    const supportQueue = filterSupportQueueForShift({
      queue: specialSupportByShift[shift] || [],
      shift,
      normalIds: normalPoolIds,
      usedInShift,
      unavailable: [...unavailableFrom.entries()].map(([caddyId, from]) => ({
        caddyId,
        reason: "UNAVAILABLE",
        effectiveFromShift: from,
      })),
    });
    const placeSupport = (reservation: AutoAssignReservation): boolean => {
      const support = pickNextSpecialSupport(supportQueue, usedInShift);
      if (!support) return false;
      usedInShift.add(support.id);
      assignments.push(
        specialSupportAssignmentRow({
          date: input.date,
          shift,
          reservation,
          caddy: support,
        })
      );
      byShift[shift].assigned += 1;
      return true;
    };
    const inSupportTail = (index: number, total: number) =>
      isReservedSupportTailSlot({
        remainingIncludingCurrent: total - index,
        supportLeft: unusedSupportCount(supportQueue, usedInShift),
      });

    if (freezeSet.has(shift)) {
      const nextCursor =
        house.length === 0
          ? 0
          : ((houseStart + houseAssigned) % house.length + house.length) %
            house.length;
      const seedSpare = seedSpareByShift.get(shift);
      if (seedSpare) {
        sparesByShift.push({
          shift,
          spare1: seedSpare.spare1,
          spare2: seedSpare.spare2,
        });
      } else {
        const spares = pickCircularHouseSpares(house, nextCursor, usedInShift);
        sparesByShift.push({
          shift,
          spare1: spares.spare1,
          spare2: spares.spare2,
        });
      }
      houseStart = nextCursor;
      continue;
    }

    if (shift === "3부") {
      const houseIds = new Set(house.map((c) => c.id));
      const workedShift1 = new Set<number>();
      const workedShift2 = new Set<number>();
      for (const a of assignments) {
        if (!houseIds.has(a.caddy.id)) continue;
        if (a.shift === "1부") workedShift1.add(a.caddy.id);
        else if (a.shift === "2부") workedShift2.add(a.caddy.id);
      }
      const worked12 = new Set<number>([...workedShift1, ...workedShift2]);
      const neverWorked = house.filter((c) => !worked12.has(c.id));
      const houseExhaustedIn12 = neverWorked.length === 0;

      const shift1Spare = sparesByShift.find((s) => s.shift === "1부");
      const excludeModeBSpare = new Set<number>();
      if (shift1Spare?.spare1?.caddyId != null) {
        excludeModeBSpare.add(shift1Spare.spare1.caddyId);
      }
      if (shift1Spare?.spare2?.caddyId != null) {
        excludeModeBSpare.add(shift1Spare.spare2.caddyId);
      }
      /** 1부 미근무 + 2부 실근무, 1부 spare1·2 제외 (원번 순) */
      const modeBHouse = house.filter(
        (c) =>
          !workedShift1.has(c.id) &&
          workedShift2.has(c.id) &&
          !excludeModeBSpare.has(c.id)
      );

      type ThirdOrderItem = {
        caddy: AutoAssignCaddy;
        sequenceIndex: number;
        kind: AssignmentKind;
        reason: string;
        pairId: string | null;
      };
      const order: ThirdOrderItem[] = [];
      const seen = new Set<number>();
      const pushCaddy = (
        caddy: AutoAssignCaddy,
        sequenceIndex: number,
        extra?: {
          kind: AssignmentKind;
          reason: string;
          pairId?: string | null;
        }
      ) => {
        if (seen.has(caddy.id)) return;
        seen.add(caddy.id);
        order.push({
          caddy,
          sequenceIndex,
          kind: extra?.kind ?? "regular",
          reason:
            extra?.reason ??
            `${reasonCode}(${shift}, seq=${sequenceIndex})`,
          pairId: extra?.pairId ?? null,
        });
      };
      const seqOf = (caddy: AutoAssignCaddy) =>
        houseIndexById.get(caddy.id) ?? 0;
      const pushOneThree = (caddy: AutoAssignCaddy) =>
        pushCaddy(caddy, -1, {
          kind: "oneThree",
          reason: REASON.ONE_THREE_PRIORITY,
          pairId: `13-${caddy.id}`,
        });
      const pushWeekend = (caddy: AutoAssignCaddy) =>
        pushCaddy(caddy, -1, {
          kind: "regular",
          reason: REASON.WEEKEND_BAND_PRIORITY,
        });

      if (!houseExhaustedIn12) {
        // Mode A: 2부 스페어(실측) → 1·3 → WEEKEND → regular THIRD → 남은 미근무 → wrap
        for (const caddy of shift2SpareCaddiesFromSpares(house, sparesByShift)) {
          pushCaddy(caddy, seqOf(caddy));
        }
        for (const caddy of oneThreeForThird) pushOneThree(caddy);
        for (const caddy of weekendBand) pushWeekend(caddy);
        for (let i = 0; i < third.length; i++) {
          pushCaddy(third[i], 10_000 + i);
        }
        for (const caddy of neverWorked) {
          pushCaddy(caddy, seqOf(caddy));
        }
        for (const c of house) {
          if (!worked12.has(c.id)) continue;
          pushCaddy(c, seqOf(c));
        }
      } else {
        // Mode B: 1·3 → WEEKEND → THIRD → 2부 실근무·1부 미근무 HOUSE (spare1·2 제외)
        for (const caddy of oneThreeForThird) pushOneThree(caddy);
        for (const caddy of weekendBand) pushWeekend(caddy);
        for (let i = 0; i < third.length; i++) {
          pushCaddy(third[i], 10_000 + i);
        }
        for (const c of modeBHouse) {
          pushCaddy(c, seqOf(c));
        }
        for (const c of house) {
          pushCaddy(c, seqOf(c));
        }
      }

      const oneThreeAssigned = new Set<number>();
      let oi = 0;
      for (let i = 0; i < shiftReservations.length; i++) {
        const reservation = shiftReservations[i];
        if (inSupportTail(i, shiftReservations.length) && placeSupport(reservation)) {
          continue;
        }
        let picked: ThirdOrderItem | null = null;
        while (oi < order.length) {
          const cand = order[oi++];
          if (usedInShift.has(cand.caddy.id)) continue;
          picked = cand;
          break;
        }

        if (!picked) {
          unassignedReservations.push({
            reservation,
            reason:
              order.length === 0
                ? "가용 캐디 없음"
                : `같은 부 중복 방지로 배치 불가(가용 HOUSE ${house.length}/THIRD ${third.length})`,
          });
          byShift[shift].unassigned += 1;
          continue;
        }

        usedInShift.add(picked.caddy.id);
        if (picked.kind === "oneThree") {
          oneThreeAssigned.add(picked.caddy.id);
        }
        if (normalizeAssignCaddyType(picked.caddy.caddyType) === "HOUSE") {
          houseAssigned += 1;
        }
        assignments.push({
          date: input.date,
          shift,
          sequenceIndex: picked.sequenceIndex,
          reason: picked.reason,
          reservation,
          caddy: picked.caddy,
          pairId: picked.pairId,
          kind: picked.kind,
        });
        byShift[shift].assigned += 1;
      }
      for (const caddy of oneThreeForThird) {
        if (oneThreeAssigned.has(caddy.id)) continue;
        specialUnassigned.push({
          caddy,
          reason: REASON.ONE_THREE_MISSING_SHIFT3,
          review: true,
        });
      }
      thirdSequence = order.map((o) => o.caddy);
      thirdNextIdx = oi;
    } else {
      // 1·2부: HOUSE만, houseStart부터 wrap. 꼬리 슬롯은 특수지원.
      let cursor =
        house.length === 0 ? 0 : ((houseStart % house.length) + house.length) % house.length;

      for (let i = 0; i < shiftReservations.length; i++) {
        const reservation = shiftReservations[i];
        if (inSupportTail(i, shiftReservations.length) && placeSupport(reservation)) {
          continue;
        }
        let picked: AutoAssignCaddy | null = null;
        let pickedIndex = -1;
        if (house.length > 0) {
          for (let attempt = 0; attempt < house.length; attempt++) {
            const idx = (cursor + attempt) % house.length;
            const caddy = house[idx];
            if (usedInShift.has(caddy.id)) continue;
            picked = caddy;
            pickedIndex = idx;
            cursor = (idx + 1) % house.length;
            break;
          }
        }

        if (!picked || pickedIndex < 0) {
          unassignedReservations.push({
            reservation,
            reason:
              house.length === 0
                ? "가용 캐디 없음"
                : `같은 부 중복 방지로 배치 불가(가용 ${house.length}명)`,
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

    if (shift === "3부" && thirdSequence) {
      const spares = pickCircularHouseSpares(
        thirdSequence,
        thirdNextIdx,
        usedInShift
      );
      sparesByShift.push({
        shift,
        spare1: spares.spare1,
        spare2: spares.spare2,
      });
      if (spares.spare1) {
        houseStart =
          houseIndexById.get(spares.spare1.caddyId) ??
          houseStart + houseAssigned;
      } else {
        houseStart = houseStart + houseAssigned;
      }
    } else {
      // 다음 부 시작점 = 순환큐상 배치 직후 위치 (modulo)
      const nextCursor =
        house.length === 0
          ? 0
          : ((houseStart + houseAssigned) % house.length + house.length) %
            house.length;
      const spares = pickCircularHouseSpares(house, nextCursor, usedInShift);
      sparesByShift.push({
        shift,
        spare1: spares.spare1,
        spare2: spares.spare2,
      });
      houseStart = nextCursor;
    }
  }

  const finalPointer =
    house.length === 0 ? 0 : ((houseStart % house.length) + house.length) % house.length;

  return {
    assignments,
    unassignedReservations,
    specialUnassigned,
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
  /** 1막 신청자 후보 — 찾근_1막(fixed)과 별개 */
  oneMakCandidates?: AutoAssignCaddy[];
  /** 명시 시 이 모드만 사용. 없으면 anchor 있으면 MANUAL, 없으면 AUTO */
  placementMode?: SpecialPlacementMode | null;
  protectedTailCount?: number;
  /** 1·3부 1부 시작 예약 (코스+티타임). MANUAL에서만 사용 */
  oneThreeAnchor?: SpecialStartAnchor | null;
  /** 1막 1부 시작 예약 (코스+티타임). MANUAL에서만 사용 */
  oneMakAnchor?: SpecialStartAnchor | null;
  /**
   * 운영 코스 Open 목록. 미지정 시 4코스 전부 ON.
   * OFF 코스 예약은 closedCourseReservations 로 분리 (CLOSED_COURSE).
   */
  openCourses?: readonly string[] | null;
  min54HoleGapMinutes?: number;
  minOneThreeGapMinutes?: number;
  minOneTwoGapMinutes?: number;
  /**
   * 오늘 1부 첫 HOUSE 캐디.
   * 미입력(legacy) → 기존 start=0.
   * 입력 시 일반 HOUSE 순환 시작점만 변경 (특수 우선순위 파이프라인 불변).
   */
  houseStartCaddyId?: number | null;
  /**
   * 오늘 3부 regular 첫 캐디.
   * 미입력 → 주간 시작조 첫 가용. 당일 불가면 다음 가용 (에러 아님).
   */
  thirdStartCaddyId?: number | null;
  /**
   * 이번 주 3부반 시작조 (9/10/11/12조).
   * 미입력 시 2026-08-17=12조 기준 자동 순환.
   */
  thirdStartTeam?: string | null;
  /**
   * 특수지원 큐. 정상 available/house/third 에 넣지 않는다.
   * 해당 부 capacity 안에 포함되며 overflow fallback이 아니다.
   */
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
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
    ...(input.oneMakCandidates || []),
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
    .sort(compareSpecialCandidateOrder);
  const fiftyFourIds = new Set(fiftyFourHole.map((c) => c.id));

  const oneThreeCandidates = dedupeCaddies([...(input.oneThreeCandidates || [])])
    .filter((c) => !fixedIds.has(c.id) && !fiftyFourIds.has(c.id))
    .sort(compareSpecialCandidateOrder);
  const oneThreeIds = new Set(oneThreeCandidates.map((c) => c.id));

  const oneTwoCandidates = dedupeCaddies([...(input.oneTwoCandidates || [])])
    .filter(
      (c) =>
        !fixedIds.has(c.id) && !fiftyFourIds.has(c.id) && !oneThreeIds.has(c.id)
    )
    .sort(compareSpecialCandidateOrder);
  const oneTwoIds = new Set(oneTwoCandidates.map((c) => c.id));

  const oneMakCandidates = dedupeCaddies([...(input.oneMakCandidates || [])])
    .filter(
      (c) =>
        !fixedIds.has(c.id) &&
        !fiftyFourIds.has(c.id) &&
        !oneThreeIds.has(c.id) &&
        !oneTwoIds.has(c.id)
    )
    .sort(compareSpecialCandidateOrder);
  const oneMakIds = new Set(oneMakCandidates.map((c) => c.id));

  const specialExclude = new Set<number>([
    ...fixedIds,
    ...fiftyFourIds,
    ...oneThreeIds,
    ...oneTwoIds,
    ...oneMakIds,
  ]);
  const special = dedupeCaddies([...(input.special || [])])
    .filter((c) => !specialExclude.has(c.id))
    .sort(compareCaddyOrder);

  const specialSupportIds = specialSupportCaddyIds(input.specialSupportByShift);
  const availableAll = dedupeCaddies([...(input.available || [])])
    .filter((caddy) => !specialSupportIds.has(caddy.id))
    .sort(compareCaddyOrder);
  const originalHouse = splitCaddyPools(availableAll).house;
  const available = availableAll.filter((c) => !specialExclude.has(c.id));
  const pools = splitCaddyPools(available);
  const regularHouse = resolveRegularHouseQueue({
    originalHouse,
    remainingHouse: pools.house,
    specialExcludeIds: specialExclude,
    houseStartCaddyId: input.houseStartCaddyId,
  });
  const thirdStartTeam = resolveThirdStartTeam(input.thirdStartTeam, date);
  const thirdStartTeamAutomatic = automaticThirdStartTeam(date);

  const originalShift1 = eligible
    .filter((row) => row.shift === "1부")
    .sort(compareReservationOrder);
  const slotted = assignSpecialDutySlots({
    date,
    reservations: fixed.remainingReservations,
    fiftyFourHole,
    oneTwoCandidates,
    oneThreeCandidates,
    oneMakCandidates,
    placementMode: input.placementMode,
    protectedTailCount: input.protectedTailCount,
    occupiedReservations: fixed.assignments,
    oneThreeAnchor: input.oneThreeAnchor,
    oneMakAnchor: input.oneMakAnchor,
    originalShift1,
    protectedShift1Keys: protectedShift1KeySet(originalShift1),
    housePoolLength: pools.house.length,
    min54HoleGapMinutes: input.min54HoleGapMinutes,
  });

  const fixedAssignments = fixed.assignments;
  const fiftyFourHoleAssignments = slotted.fiftyFourHoleAssignments;
  const oneTwoAssignments = slotted.oneTwoAssignments;
  const oneMakAssignments = slotted.oneMakAssignments;
  const remainingEligible = slotted.remainingReservations.sort(
    compareReservationOrder
  );

  // 4) 일반 순번 — 1·2부 후 3부: 2부 스페어 → 1·3 → WEEKEND → regular
  // houseStartCaddyId는 일반 HOUSE에서 적용. 시작점이 특수근무로 빠지면
  // 원본 HOUSE 회전 후 특수 id만 제외하고 이어간다 (전체 abort 없음).
  const regular = assignRegularSequence({
    date,
    house: regularHouse.house,
    third: pools.third,
    reservations: remainingEligible,
    reasonCode: REASON.REGULAR_SEQUENCE,
    houseStartCaddyId: regularHouse.houseStartCaddyId,
    thirdStartTeam,
    thirdStartCaddyId: input.thirdStartCaddyId,
    thirdRoster: caddyDirectory,
    oneThreeForThird: slotted.oneThreePlaced,
    specialSupportByShift: input.specialSupportByShift,
    occupiedAssignments: [
      ...fixedAssignments,
      ...fiftyFourHoleAssignments,
      ...oneTwoAssignments,
      ...oneMakAssignments,
      ...slotted.oneThreeAssignments,
    ],
  });
  const oneThreeThirdAssignments = regular.assignments.filter(
    (row) => row.kind === "oneThree"
  );
  const weekendBandAssignments = regular.assignments.filter(isWeekendBandRow);
  const specialSupportAssignments = regular.assignments.filter(
    (row) => row.kind === "specialSupport"
  );
  const regularAssignments = regular.assignments.filter(
    (row) => row.kind === "regular" && !isWeekendBandRow(row)
  );
  const oneThreeAssignments = [
    ...slotted.oneThreeAssignments,
    ...oneThreeThirdAssignments,
  ];
  const specialUnassigned = [
    ...fixed.specialUnassigned,
    ...slotted.specialUnassigned,
    ...regular.specialUnassigned,
  ];
  unassignedReservations.push(...regular.unassignedReservations);

  for (const shift of SHIFT_PARTS) {
    byShift[shift].assigned += regular.byShift[shift].assigned;
    byShift[shift].unassigned += regular.byShift[shift].unassigned;
  }

  for (const a of [
    ...fixedAssignments,
    ...fiftyFourHoleAssignments,
    ...slotted.oneThreeAssignments,
    ...oneTwoAssignments,
    ...oneMakAssignments,
  ]) {
    byShift[a.shift].assigned += 1;
  }

  const usedCaddyIds = new Set<number>([
    ...fixed.assignedCaddyIds,
    ...slotted.assignedCaddyIds,
    ...regular.assignments.map((a) => a.caddy.id),
  ]);

  const assignments = [
    ...fixedAssignments,
    ...fiftyFourHoleAssignments,
    ...oneThreeAssignments,
    ...oneTwoAssignments,
    ...oneMakAssignments,
    ...weekendBandAssignments,
    ...regularAssignments,
    ...specialSupportAssignments,
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
  const oneMakAssignedCaddyCount = new Set(
    oneMakAssignments.map((a) => a.caddy.id)
  ).size;

  return {
    date,
    assignments,
    fixedAssignments,
    fiftyFourHoleAssignments,
    oneThreeAssignments,
    oneTwoAssignments,
    oneMakAssignments,
    weekendBandAssignments,
    regularAssignments,
    unassignedReservations,
    closedCourseReservations,
    unusedCaddies,
    special,
    specialUnassigned,
    openCourses,
    sparesByShift: regular.sparesByShift,
    specialSupportByShift:
      input.specialSupportByShift || emptySpecialSupportByShift(),
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
      fiftyFourHoleUnassignedCount: slotted.specialUnassigned.filter((u) =>
        u.reason.startsWith("54HOLE")
      ).length,
      oneThreeCandidateCount: oneThreeCandidates.length,
      oneThreeAssignedCaddyCount,
      oneThreeUnassignedCount: specialUnassigned.filter((u) =>
        u.reason.startsWith("ONE_THREE")
      ).length,
      oneTwoCandidateCount: oneTwoCandidates.length,
      oneTwoAssignedCaddyCount,
      oneTwoUnassignedCount: slotted.specialUnassigned.filter((u) =>
        u.reason.startsWith("ONE_TWO")
      ).length,
      oneMakCandidateCount: oneMakCandidates.length,
      oneMakAssignedCaddyCount,
      oneMakUnassignedCount: slotted.specialUnassigned.filter((u) =>
        u.reason.startsWith("ONE_MAK")
      ).length,
      housePoolCount: pools.house.length,
      thirdPoolCount: pools.third.length,
      drivingPoolCount: pools.driving.length,
      byShift,
      finalPointer: regular.finalPointer,
      ...(input.houseStartCaddyId != null
        ? { houseStartCaddyId: Number(input.houseStartCaddyId) }
        : {}),
      ...(input.thirdStartCaddyId != null
        ? { thirdStartCaddyId: Number(input.thirdStartCaddyId) }
        : {}),
      thirdStartTeam,
      thirdStartTeamAutomatic,
    },
    specialPlacement: slotted.specialPlacement,
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

export function isDrivingPlacement(row: Pick<AutoAssignmentRow, "kind">): boolean {
  return row.kind === "driving";
}

export function isLimousineReservation(
  reservation: Pick<AutoAssignReservation, "limousineCart">
): boolean {
  return reservation.limousineCart === true;
}

export function isWeekendBandRow(row: Pick<AutoAssignmentRow, "reason">): boolean {
  const reason = String(row.reason || "");
  return (
    reason === REASON.WEEKEND_BAND_PRIORITY ||
    reason.startsWith(`${REASON.WEEKEND_BAND_PRIORITY}(`)
  );
}

/** 미지정 locked의 기본값: 특수 kind·주말반 ON, 일반 OFF.
 * 1부 ONE_THREE/ONE_MAK은 AUTO 재계산 대상이라 기본 OFF.
 * MANUAL/SET_LOCK은 배치 시 locked=true를 명시한다. */
export function defaultPlacementLocked(
  row: Pick<AutoAssignmentRow, "kind" | "reason" | "shift">
): boolean {
  if (row.kind === "specialSupport") return false;
  if (
    (row.kind === "oneThree" || row.kind === "oneMak") &&
    row.shift === "1부"
  ) {
    return false;
  }
  if (row.kind !== "regular") return true;
  return isWeekendBandRow(row);
}

/**
 * cancel/add reflow에서 티타임에 고정할지.
 * 명시적 locked(SET_LOCK/SWAP 후 고정/드라이빙)는 유지.
 * 3부 1·3·주말반은 기본 LOCK 표시를 유지하되, 우선순위 재적용을 위해 슬롯은 재배치한다.
 */
export function preservePlacementOnReflow(row: AutoAssignmentRow): boolean {
  if (row.kind === "specialSupport") return false;
  if (typeof row.locked === "boolean") return row.locked;
  if (row.shift === "3부" && row.kind === "oneThree") return false;
  if (row.shift === "3부" && isWeekendBandRow(row)) return false;
  return defaultPlacementLocked(row);
}

export function isActiveEmploymentStatus(value: unknown): boolean {
  const raw = String(value ?? "ACTIVE").trim().toUpperCase();
  if (raw === "LEAVE" || raw === "RETIRED" || raw === "휴직" || raw === "퇴사") {
    return false;
  }
  return true;
}

/** 드라이빙 지정 후보. 일반 HOUSE/THIRD로 대체하지 않음. */
export function drivingCandidateCaddies(input: {
  pool: AutoAssignCaddy[];
  assignedCaddyIds?: Iterable<number>;
  unavailableCaddyIds?: Iterable<number>;
}): AutoAssignCaddy[] {
  const assigned = new Set(
    [...(input.assignedCaddyIds || [])].map((id) => Number(id))
  );
  const unavailable = new Set(
    [...(input.unavailableCaddyIds || [])].map((id) => Number(id))
  );
  return input.pool.filter((c) => {
    if (normalizeAssignCaddyType(c.caddyType) !== "DRIVING") return false;
    if (!isActiveEmploymentStatus(c.employmentStatus)) return false;
    if (assigned.has(c.id)) return false;
    if (unavailable.has(c.id)) return false;
    return c.id > 0 && !!c.name;
  });
}

export function isPlacementLocked(row: AutoAssignmentRow): boolean {
  if (typeof row.locked === "boolean") return row.locked;
  return defaultPlacementLocked(row);
}

function cloneAssignmentRow(row: AutoAssignmentRow): AutoAssignmentRow {
  return {
    ...row,
    reservation: { ...row.reservation },
    caddy: { ...row.caddy },
  };
}

function specialTagRow(row: AutoAssignmentRow): boolean {
  if (row.kind === "specialSupport") return false;
  return row.kind !== "regular" || isWeekendBandRow(row);
}

function bucketizeAssignments(assignments: AutoAssignmentRow[]): {
  fixedAssignments: AutoAssignmentRow[];
  fiftyFourHoleAssignments: AutoAssignmentRow[];
  oneThreeAssignments: AutoAssignmentRow[];
  oneTwoAssignments: AutoAssignmentRow[];
  oneMakAssignments: AutoAssignmentRow[];
  weekendBandAssignments: AutoAssignmentRow[];
  regularAssignments: AutoAssignmentRow[];
} {
  const fixedAssignments: AutoAssignmentRow[] = [];
  const fiftyFourHoleAssignments: AutoAssignmentRow[] = [];
  const oneThreeAssignments: AutoAssignmentRow[] = [];
  const oneTwoAssignments: AutoAssignmentRow[] = [];
  const oneMakAssignments: AutoAssignmentRow[] = [];
  const weekendBandAssignments: AutoAssignmentRow[] = [];
  const regularAssignments: AutoAssignmentRow[] = [];
  for (const row of assignments) {
    if (row.kind === "fixed") fixedAssignments.push(row);
    else if (row.kind === "fiftyFourHole") fiftyFourHoleAssignments.push(row);
    else if (row.kind === "oneThree") oneThreeAssignments.push(row);
    else if (row.kind === "oneTwo") oneTwoAssignments.push(row);
    else if (row.kind === "oneMak") oneMakAssignments.push(row);
    else if (isWeekendBandRow(row)) weekendBandAssignments.push(row);
    else regularAssignments.push(row);
  }
  return {
    fixedAssignments,
    fiftyFourHoleAssignments,
    oneThreeAssignments,
    oneTwoAssignments,
    oneMakAssignments,
    weekendBandAssignments,
    regularAssignments,
  };
}

function fixedCancelledCaddyIds(result: AutoAssignResultV1): Set<number> {
  const ids = new Set<number>();
  for (const u of result.specialUnassigned || []) {
    if (u.reason === REASON.FIXED_CANCELLED) ids.add(u.caddy.id);
  }
  return ids;
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

function emptyReflowSummary(specialPreserved = 0) {
  return {
    movedBackward: 0,
    movedForward: 0,
    unchanged: 0,
    newlyAssigned: 0,
    becameUnassigned: 0,
    specialPreserved,
    pulledCount: 0,
    pushedCount: 0,
    lockedPreservedCount: specialPreserved,
  };
}

function buildCaddyChanges(
  beforeRows: AutoAssignmentRow[],
  afterRows: AutoAssignmentRow[],
  pool: AutoAssignCaddy[]
): ReflowCaddyChange[] {
  const beforeMap = orderIndexMap(beforeRows);
  const afterMap = orderIndexMap(afterRows);
  const caddyIds = new Set<number>([...beforeMap.keys(), ...afterMap.keys()]);
  const changes: ReflowCaddyChange[] = [];
  for (const id of caddyIds) {
    const before = beforeMap.get(id);
    const afterRow = afterMap.get(id);
    const caddy =
      afterRows.find((a) => a.caddy.id === id)?.caddy ||
      beforeRows.find((a) => a.caddy.id === id)?.caddy ||
      pool.find((c) => c.id === id);
    if (!caddy) continue;

    if (before && afterRow) {
      const sameRes =
        reservationKey(before.reservation) ===
        reservationKey(afterRow.reservation);
      let kind: ReflowChangeKind = "unchanged";
      if (!sameRes) {
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
  return changes;
}

function buildPlacementDiffs(
  before: AutoAssignResultV1,
  after: AutoAssignResultV1,
  lockedKeys: Set<string>
): PlacementDiff[] {
  const beforeByKey = new Map<string, AutoAssignmentRow>();
  for (const row of before.assignments) {
    beforeByKey.set(reservationKey(row.reservation), row);
  }
  const afterByKey = new Map<string, AutoAssignmentRow>();
  for (const row of after.assignments) {
    afterByKey.set(reservationKey(row.reservation), row);
  }
  const keys = new Set<string>([...beforeByKey.keys(), ...afterByKey.keys()]);
  const diffs: PlacementDiff[] = [];
  for (const key of keys) {
    const b = beforeByKey.get(key);
    const a = afterByKey.get(key);
    const reservation = a?.reservation || b?.reservation;
    if (!reservation) continue;
    diffs.push({
      reservationKey: key,
      reservation,
      beforeCaddy: b?.caddy ?? null,
      afterCaddy: a?.caddy ?? null,
      lockedPreserved: lockedKeys.has(key) && !!b && !!a && b.caddy.id === a.caddy.id,
    });
  }
  diffs.sort((x, y) => compareReservationOrder(x.reservation, y.reservation));
  return diffs;
}

function summarizeChanges(
  changes: ReflowCaddyChange[],
  specialPreserved: number,
  lockedPreservedCount: number
): RegularReflowResult["summary"] {
  const movedBackward = changes.filter((c) => c.kind === "movedBackward").length;
  const movedForward = changes.filter((c) => c.kind === "movedForward").length;
  return {
    movedBackward,
    movedForward,
    unchanged: changes.filter((c) => c.kind === "unchanged").length,
    newlyAssigned: changes.filter((c) => c.kind === "newlyAssigned").length,
    becameUnassigned: changes.filter((c) => c.kind === "becameUnassigned").length,
    specialPreserved,
    pulledCount: movedForward,
    pushedCount: movedBackward,
    lockedPreservedCount,
  };
}

function courseLabelForWarning(course: string): string {
  const code = resolveCourseCode(course);
  return (code && COURSE_LABELS[code]) || course;
}

function courseTeeCollision(
  candidate: AutoAssignReservation,
  existing: AutoAssignReservation[]
): AutoAssignReservation | null {
  const course = String(candidate.course || "").toUpperCase();
  const tee = String(candidate.teeTime || "");
  const shift = String(candidate.shift || "");
  return (
    existing.find(
      (r) =>
        String(r.course || "").toUpperCase() === course &&
        String(r.teeTime || "") === tee &&
        String(r.shift || "") === shift &&
        reservationKey(r) !== reservationKey(candidate)
    ) || null
  );
}

function overlaySpecialTag(
  row: AutoAssignmentRow,
  previousByCaddy: Map<number, AutoAssignmentRow>
): AutoAssignmentRow {
  const prev = previousByCaddy.get(row.caddy.id);
  if (!prev || !specialTagRow(prev)) {
    return { ...row, locked: false };
  }
  return {
    ...row,
    kind: prev.kind,
    pairId: prev.pairId ?? row.pairId,
    note: prev.note ?? row.note,
    reason: prev.reason,
    locked: false,
  };
}

function resolveReflowReason(input: {
  swapCount: number;
  cancelCount: number;
  teamNoshowCount: number;
  addCount: number;
  removeCount: number;
  moveCount: number;
}): string {
  const kinds =
    (input.swapCount > 0 ? 1 : 0) +
    (input.cancelCount + input.teamNoshowCount > 0 ? 1 : 0) +
    (input.addCount > 0 ? 1 : 0) +
    (input.removeCount > 0 ? 1 : 0) +
    (input.moveCount > 0 ? 1 : 0);
  if (input.swapCount > 0 && kinds === 1) return REASON.CADDY_SWAP;
  if (input.moveCount > 0 && kinds === 1) return REASON.RESERVATION_MOVE_REFLOW;
  if (kinds > 1) return REASON.REGULAR_MIXED_REFLOW;
  if (input.removeCount > 0) return REASON.CADDY_UNAVAILABLE_REFLOW;
  if (input.addCount > 0) return REASON.REGULAR_ADD_REFLOW;
  if (input.teamNoshowCount > 0 && input.cancelCount === 0) {
    return REASON.TEAM_NOSHOW_REFLOW;
  }
  return REASON.REGULAR_CANCEL_REFLOW;
}

function stampResultReservationIdentities(
  previous: AutoAssignResultV1
): AutoAssignResultV1 {
  const used = new Set<string>();
  return patchResultReservations(previous, (reservation) =>
    ensureReservationUid(reservation, used)
  );
}

function stabilizeMoveReservationIdentities(
  previous: AutoAssignResultV1,
  events: ReservationChangeEvent[]
): { previous: AutoAssignResultV1; events: ReservationChangeEvent[] } {
  const stampedPrevious = stampResultReservationIdentities(previous);
  const nextEvents = events.map((event) => {
    if (event.type !== "MOVE_RESERVATION") return event;
    const row =
      findMoveSourceRow(stampedPrevious, event) ||
      findMoveSourceRow(previous, event);
    if (!row) return event;
    const stamped = ensureReservationUid(row.reservation);
    const stableKey = reservationKey(stamped);
    if (event.reservationKey === stableKey) return event;
    return { ...event, reservationKey: stableKey };
  });
  return { previous: stampedPrevious, events: nextEvents };
}

function parseMoveEventDestination(to: {
  course?: unknown;
  shift?: unknown;
  teeTime?: unknown;
} | null | undefined): { course: CourseCode; shift: ShiftPart; teeTime: string } | null {
  if (!to) return null;
  const course = resolveCourseCode(String(to.course ?? ""));
  const shift = parseAssignShiftPart(to.shift);
  const teeTime = parseTeeTime(to.teeTime);
  if (!course || !shift || !teeTime) return null;
  return { course, shift, teeTime };
}

function findMoveSourceRow(
  previous: AutoAssignResultV1,
  event: Extract<ReservationChangeEvent, { type: "MOVE_RESERVATION" }>
): AutoAssignmentRow | null {
  if (event.reservationId != null && String(event.reservationId) !== "") {
    const byId = previous.assignments.find((row) =>
      reservationMatchesIdentity(row.reservation, null, event.reservationId)
    );
    if (byId) return byId;
  }
  if (event.reservationKey) {
    const byKey = previous.assignments.find((row) =>
      reservationMatchesIdentity(
        row.reservation,
        event.reservationKey,
        event.reservationId
      )
    );
    if (byKey) return byKey;
  }
  return null;
}

function sameMoveSlot(
  reservation: AutoAssignReservation,
  dest: { course: string; shift: string; teeTime: string }
): boolean {
  return (
    resolveCourseCode(String(reservation.course)) ===
      resolveCourseCode(String(dest.course)) &&
    parseAssignShiftPart(reservation.shift) === parseAssignShiftPart(dest.shift) &&
    String(reservation.teeTime) === String(dest.teeTime)
  );
}

function validateReservationMoveEvents(
  previous: AutoAssignResultV1,
  events: Extract<ReservationChangeEvent, { type: "MOVE_RESERVATION" }>[]
): ReflowWarning[] {
  const warnings: ReflowWarning[] = [];
  const openCourses = new Set(
    (previous.openCourses || [...COURSE_ORDER]).map((c) =>
      String(resolveCourseCode(String(c)) || c).toUpperCase()
    )
  );
  for (const event of events) {
    const dest = parseMoveEventDestination(event.to);
    if (!dest) {
      warnings.push({
        level: "error",
        code: "MOVE_BAD_DESTINATION",
        message: "목적 코스·부·티타임을 확인하세요.",
        reservationKey: event.reservationKey,
      });
      continue;
    }
    if (event.to.date && String(event.to.date) !== previous.date) {
      warnings.push({
        level: "error",
        code: "MOVE_DATE_CHANGE",
        message: "다른 날짜로는 이동할 수 없습니다.",
        reservationKey: event.reservationKey,
      });
      continue;
    }
    const row = findMoveSourceRow(previous, event);
    if (!row) {
      warnings.push({
        level: "error",
        code: "MOVE_NOT_FOUND",
        message: "이동할 예약을 찾을 수 없습니다.",
        reservationKey: event.reservationKey,
      });
      continue;
    }
    if (isDrivingPlacement(row) || row.kind === "driving") {
      warnings.push({
        level: "error",
        code: "MOVE_DRIVING",
        message: "드라이빙 배치는 1차 팀 이동 대상이 아닙니다.",
        reservationKey: reservationKey(row.reservation),
      });
      continue;
    }
    if (row.kind !== "regular" || isWeekendBandRow(row)) {
      warnings.push({
        level: "error",
        code: "MOVE_SPECIAL",
        message: "특수 배치(LOCK/1·3/주말반 등)는 1차에서 이동할 수 없습니다.",
        reservationKey: reservationKey(row.reservation),
      });
      continue;
    }
    if (isPlacementLocked(row) || row.locked === true) {
      warnings.push({
        level: "error",
        code: "MOVE_LOCKED",
        message: "LOCK ON 예약은 잠금을 해제한 뒤에만 이동할 수 있습니다.",
        reservationKey: reservationKey(row.reservation),
      });
      continue;
    }
    if (!openCourses.has(String(dest.course).toUpperCase())) {
      warnings.push({
        level: "error",
        code: "MOVE_CLOSED_COURSE",
        message: "닫힌 코스로는 이동할 수 없습니다.",
        reservationKey: reservationKey(row.reservation),
      });
      continue;
    }
    if (sameMoveSlot(row.reservation, dest)) {
      warnings.push({
        level: "error",
        code: "MOVE_SAME_SLOT",
        message: "목적지가 현재 위치와 같습니다.",
        reservationKey: reservationKey(row.reservation),
      });
      continue;
    }
    const others = [
      ...previous.assignments.map((a) => a.reservation),
      ...(previous.unassignedReservations || []).map((u) => u.reservation),
    ];
    const hit = courseTeeCollision(
      {
        ...row.reservation,
        course: dest.course,
        shift: dest.shift,
        teeTime: dest.teeTime,
      },
      others
    );
    if (hit) {
      warnings.push({
        level: "error",
        code: "DUPLICATE_COURSE_TEETIME",
        message: `해당 코스/티타임에 이미 예약이 있습니다 (${courseLabelForWarning(hit.course)} ${hit.teeTime}).`,
        reservationKey: reservationKey(row.reservation),
      });
    }
  }
  return warnings;
}

function reservationMatchesKey(
  reservation: AutoAssignReservation,
  key?: string,
  id?: string | number
): boolean {
  return reservationMatchesIdentity(reservation, key, id);
}

function patchResultReservations(
  previous: AutoAssignResultV1,
  patch: (reservation: AutoAssignReservation) => AutoAssignReservation
): AutoAssignResultV1 {
  const assignments = previous.assignments.map((row) => ({
    ...cloneAssignmentRow(row),
    reservation: patch(row.reservation),
  }));
  const buckets = bucketizeAssignments(assignments);
  return {
    ...previous,
    ...buckets,
    assignments,
    unassignedReservations: (previous.unassignedReservations || []).map((u) => ({
      ...u,
      reservation: patch(u.reservation),
    })),
    closedCourseReservations: (previous.closedCourseReservations || []).map((u) => ({
      ...u,
      reservation: patch(u.reservation),
    })),
  };
}

function findCaddyInScope(
  previous: AutoAssignResultV1,
  pool: AutoAssignCaddy[],
  caddyId: number
): AutoAssignCaddy | null {
  return (
    pool.find((c) => c.id === caddyId) ||
    previous.assignments.find((a) => a.caddy.id === caddyId)?.caddy ||
    previous.unusedCaddies.find((c) => c.id === caddyId) ||
    previous.special.find((c) => c.id === caddyId) ||
    null
  );
}

function applyLimousineOnly(
  previous: AutoAssignResultV1,
  event: Extract<ReservationChangeEvent, { type: "SET_LIMOUSINE" }>,
  pool: AutoAssignCaddy[]
): RegularReflowResult {
  const warnings: ReflowWarning[] = [];
  const found =
    previous.assignments.some((a) =>
      reservationMatchesKey(a.reservation, event.reservationKey, event.reservationId)
    ) ||
    (previous.unassignedReservations || []).some((u) =>
      reservationMatchesKey(u.reservation, event.reservationKey, event.reservationId)
    );
  if (!found) {
    warnings.push({
      level: "error",
      code: "LIMOUSINE_TARGET_NOT_FOUND",
      message: "리무진 표시 대상 예약을 찾을 수 없습니다.",
      reservationKey: event.reservationKey,
    });
    return {
      date: previous.date,
      reason: REASON.LIMOUSINE_SET,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  const after = patchResultReservations(previous, (reservation) =>
    reservationMatchesKey(reservation, event.reservationKey, event.reservationId)
      ? { ...reservation, limousineCart: event.limousineCart }
      : reservation
  );
  const lockedPreserved = after.assignments.filter(isPlacementLocked).map((row) => ({
    reservationKey: reservationKey(row.reservation),
    caddy: row.caddy,
    kind: row.kind,
    reason: row.reason,
  }));
  const lockedKeys = new Set(lockedPreserved.map((r) => r.reservationKey));
  return {
    date: previous.date,
    reason: REASON.LIMOUSINE_SET,
    before: previous,
    after,
    changes: [],
    placementDiffs: buildPlacementDiffs(previous, after, lockedKeys),
    lockedPreserved,
    warnings,
    unavailableCaddyIds: [],
    summary: summarizeChanges([], lockedPreserved.length, lockedPreserved.length),
  };
}

function boardAfterMutation(
  previous: AutoAssignResultV1,
  assignments: AutoAssignmentRow[],
  unassignedReservations: UnassignedReservationRow[],
  extraUnused: AutoAssignCaddy[]
): AutoAssignResultV1 {
  const sorted = assignments.map(cloneAssignmentRow).sort(compareAssignmentOrder);
  const buckets = bucketizeAssignments(sorted);
  const used = new Set(sorted.map((a) => a.caddy.id));
  const unusedCaddies = dedupeCaddies([
    ...previous.unusedCaddies,
    ...extraUnused,
  ]).filter((c) => !used.has(c.id));
  return {
    ...previous,
    ...buckets,
    assignments: sorted,
    unassignedReservations,
    unusedCaddies,
    meta: {
      ...previous.meta,
      assignedCount: sorted.length,
      unassignedCount: unassignedReservations.length,
      unusedCount: unusedCaddies.length,
    },
  };
}

function cloneUnassigned(
  rows: UnassignedReservationRow[] | undefined
): UnassignedReservationRow[] {
  return (rows || []).map((row) => ({
    reservation: { ...row.reservation },
    reason: row.reason,
  }));
}

function otherShiftRows(assignments: AutoAssignmentRow[]): AutoAssignmentRow[] {
  return assignments
    .filter((row) => String(row.reservation.shift) !== "3부")
    .map(cloneAssignmentRow);
}

function thirdShiftRows(assignments: AutoAssignmentRow[]): AutoAssignmentRow[] {
  return assignments
    .filter((row) => String(row.reservation.shift) === "3부")
    .map(cloneAssignmentRow)
    .sort(compareAssignmentOrder);
}

function unlockedRegularChainIndexes(
  third: AutoAssignmentRow[],
  targetIndex: number
): number[] {
  const chain = [targetIndex];
  for (let i = targetIndex + 1; i < third.length; i += 1) {
    const row = third[i]!;
    if (row.kind === "regular" && !isPlacementLocked(row)) {
      chain.push(i);
    }
  }
  return chain;
}

function placeRegularCaddy(
  dest: AutoAssignmentRow,
  caddy: AutoAssignCaddy,
  reason: string
): AutoAssignmentRow {
  return {
    ...cloneAssignmentRow(dest),
    caddy: { ...caddy },
    kind: "regular",
    locked: false,
    reason,
  };
}

function thirdSpareCaddies(
  previous: AutoAssignResultV1,
  pool: AutoAssignCaddy[]
): AutoAssignCaddy[] {
  const row = (previous.sparesByShift || []).find((s) => s.shift === "3부");
  if (!row) return [];
  const out: AutoAssignCaddy[] = [];
  for (const info of [row.spare1, row.spare2]) {
    if (!info) continue;
    const found =
      previous.unusedCaddies.find((c) => c.id === info.caddyId) ||
      pool.find((c) => c.id === info.caddyId) ||
      previous.assignments.find((a) => a.caddy.id === info.caddyId)?.caddy;
    out.push(
      found
        ? { ...found }
        : {
            id: info.caddyId,
            name: info.name,
            team: info.team,
            teamOrder: info.teamOrder,
          }
    );
  }
  return out;
}

function patchThirdSpares(
  previous: SpareByShift[] | undefined,
  sparePeople: AutoAssignCaddy[]
): SpareByShift[] {
  const unique: AutoAssignCaddy[] = [];
  for (const caddy of sparePeople) {
    if (unique.some((row) => row.id === caddy.id)) continue;
    unique.push(caddy);
  }
  const source = previous?.length ? previous : emptySparesByShift();
  return SHIFT_PARTS.map((shift) => {
    const prev = source.find((row) => row.shift === shift) || {
      shift,
      spare1: null,
      spare2: null,
    };
    if (shift !== "3부") {
      return { ...prev };
    }
    return {
      shift: "3부",
      spare1: toSpareInfo(unique[0]),
      spare2: toSpareInfo(unique[1]),
    };
  });
}

function resultFromScopedBoard(
  original: AutoAssignResultV1,
  after: AutoAssignResultV1,
  pool: AutoAssignCaddy[],
  reason: string,
  warnings: ReflowWarning[]
): RegularReflowResult {
  const changes = buildCaddyChanges(original.assignments, after.assignments, pool);
  const lockedPreserved = after.assignments
    .filter(isPlacementLocked)
    .map((row) => ({
      reservationKey: reservationKey(row.reservation),
      caddy: row.caddy,
      kind: row.kind,
      reason: row.reason,
    }));
  const lockedKeys = new Set(lockedPreserved.map((row) => row.reservationKey));
  return {
    date: original.date,
    reason,
    before: original,
    after,
    changes,
    placementDiffs: buildPlacementDiffs(original, after, lockedKeys),
    lockedPreserved,
    warnings,
    unavailableCaddyIds: [],
    summary: summarizeChanges(
      changes,
      lockedPreserved.length,
      lockedPreserved.length
    ),
  };
}

function scopedThirdBoard(args: {
  previous: AutoAssignResultV1;
  nextThird: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  extraUnused: AutoAssignCaddy[];
  thirdSparePeople: AutoAssignCaddy[];
}): AutoAssignResultV1 {
  const nextAssignments = [
    ...otherShiftRows(args.previous.assignments),
    ...args.nextThird,
  ];
  const after = boardAfterMutation(
    args.previous,
    nextAssignments,
    args.unassignedReservations,
    args.extraUnused
  );
  const used = new Set(after.assignments.map((row) => row.caddy.id));
  return {
    ...after,
    sparesByShift: patchThirdSpares(
      args.previous.sparesByShift,
      args.thirdSparePeople.filter((caddy) => !used.has(caddy.id))
    ),
  };
}

function applyDrivingAssign(
  previous: AutoAssignResultV1,
  event: Extract<ReservationChangeEvent, { type: "ASSIGN_DRIVING" }>,
  pool: AutoAssignCaddy[]
): RegularReflowResult {
  const warnings: ReflowWarning[] = [];
  const assignedIdx = previous.assignments.findIndex(
    (a) => reservationKey(a.reservation) === event.reservationKey
  );
  const unassignedIdx = (previous.unassignedReservations || []).findIndex(
    (u) => reservationKey(u.reservation) === event.reservationKey
  );
  const sourceRow =
    assignedIdx >= 0 ? previous.assignments[assignedIdx] : null;
  const sourceUnassigned =
    unassignedIdx >= 0 ? previous.unassignedReservations[unassignedIdx] : null;
  const reservation = sourceRow?.reservation || sourceUnassigned?.reservation;
  if (!reservation) {
    warnings.push({
      level: "error",
      code: "DRIVING_TARGET_NOT_FOUND",
      message: "드라이빙 지정 대상 예약을 찾을 수 없습니다.",
      reservationKey: event.reservationKey,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_ASSIGN,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  if (String(reservation.shift) !== "3부") {
    warnings.push({
      level: "error",
      code: "DRIVING_SHIFT_REQUIRED",
      message: "드라이빙 캐디는 3부 예약에만 지정할 수 있습니다.",
      reservationKey: event.reservationKey,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_ASSIGN,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  const caddy = findCaddyInScope(previous, pool, event.caddyId);
  if (!caddy) {
    warnings.push({
      level: "error",
      code: "DRIVING_CADDY_NOT_FOUND",
      message: `캐디 #${event.caddyId}를 찾을 수 없습니다.`,
      caddyId: event.caddyId,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_ASSIGN,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  if (normalizeAssignCaddyType(caddy.caddyType) !== "DRIVING") {
    warnings.push({
      level: "error",
      code: "DRIVING_TYPE_REQUIRED",
      message: "드라이빙 캐디만 지정할 수 있습니다.",
      caddyId: event.caddyId,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_ASSIGN,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  if (!isActiveEmploymentStatus(caddy.employmentStatus)) {
    warnings.push({
      level: "error",
      code: "DRIVING_NOT_ACTIVE",
      message: `${caddy.name}은(는) 재직 상태가 아닙니다.`,
      caddyId: event.caddyId,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_ASSIGN,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  const other = previous.assignments.find(
    (a) =>
      a.caddy.id === event.caddyId &&
      reservationKey(a.reservation) !== event.reservationKey
  );
  if (other) {
    warnings.push({
      level: "error",
      code: "DRIVING_CADDY_ALREADY_ASSIGNED",
      message: `${caddy.name}은(는) 이미 다른 예약에 배치되어 있습니다.`,
      caddyId: event.caddyId,
      reservationKey: reservationKey(other.reservation),
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_ASSIGN,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }

  const drivingRow: AutoAssignmentRow = {
    date: previous.date,
    shift: "3부",
    sequenceIndex: sourceRow?.sequenceIndex ?? -1,
    reason: REASON.DRIVING_ASSIGN,
    reservation: { ...reservation },
    caddy: { ...caddy },
    pairId: sourceRow?.pairId ?? null,
    kind: "driving",
    locked: true,
    note: sourceRow?.note ?? null,
  };

  // 미배치 예약에 지정: 그 자리만 채우고 1·2·3부 기존 placement는 건드리지 않음.
  if (!sourceRow) {
    const after = scopedThirdBoard({
      previous,
      nextThird: [...thirdShiftRows(previous.assignments), drivingRow],
      unassignedReservations: cloneUnassigned(previous.unassignedReservations).filter(
        (u) => reservationKey(u.reservation) !== event.reservationKey
      ),
      extraUnused: [],
      thirdSparePeople: thirdSpareCaddies(previous, pool),
    });
    return resultFromScopedBoard(
      previous,
      after,
      pool,
      REASON.DRIVING_ASSIGN,
      warnings
    );
  }

  const third = thirdShiftRows(previous.assignments);
  const targetIndex = third.findIndex(
    (row) => reservationKey(row.reservation) === event.reservationKey
  );
  if (targetIndex < 0) {
    warnings.push({
      level: "error",
      code: "DRIVING_TARGET_NOT_FOUND",
      message: "드라이빙 지정 대상 예약을 찾을 수 없습니다.",
      reservationKey: event.reservationKey,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_ASSIGN,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }

  const nextThird = third.map(cloneAssignmentRow);
  if (isDrivingPlacement(third[targetIndex]!)) {
    nextThird[targetIndex] = {
      ...drivingRow,
      sequenceIndex: third[targetIndex]!.sequenceIndex,
      reservation: { ...third[targetIndex]!.reservation },
    };
    const after = scopedThirdBoard({
      previous,
      nextThird,
      unassignedReservations: cloneUnassigned(previous.unassignedReservations),
      extraUnused:
        third[targetIndex]!.caddy.id !== caddy.id ? [third[targetIndex]!.caddy] : [],
      thirdSparePeople: thirdSpareCaddies(previous, pool),
    });
    return resultFromScopedBoard(
      previous,
      after,
      pool,
      REASON.DRIVING_ASSIGN,
      warnings
    );
  }

  // 3부 local shift: target에 DRIVING LOCK 삽입, 이후 일반 UNLOCKED만 한 칸 밀림.
  // LOCK placement는 reservation에 유지하고 건너뛴다. assignRegularSequence 재실행 금지.
  const chainIdxs = unlockedRegularChainIndexes(third, targetIndex);
  const displaced = chainIdxs.map((idx) => third[idx]!.caddy);
  nextThird[targetIndex] = {
    ...drivingRow,
    sequenceIndex: third[targetIndex]!.sequenceIndex,
    reservation: { ...third[targetIndex]!.reservation },
  };
  for (let k = 1; k < chainIdxs.length; k += 1) {
    const destIdx = chainIdxs[k]!;
    const person = displaced[k - 1]!;
    nextThird[destIdx] = placeRegularCaddy(
      third[destIdx]!,
      person,
      `${person.name} 순번 이동`
    );
  }
  const leftover = displaced[chainIdxs.length - 1];
  const after = scopedThirdBoard({
    previous,
    nextThird,
    unassignedReservations: cloneUnassigned(previous.unassignedReservations),
    extraUnused: leftover ? [leftover] : [],
    thirdSparePeople: [
      ...(leftover ? [leftover] : []),
      ...thirdSpareCaddies(previous, pool),
    ],
  });
  return resultFromScopedBoard(
    previous,
    after,
    pool,
    REASON.DRIVING_ASSIGN,
    warnings
  );
}

function applyDrivingClear(
  previous: AutoAssignResultV1,
  event: Extract<ReservationChangeEvent, { type: "CLEAR_DRIVING" }>,
  pool: AutoAssignCaddy[]
): RegularReflowResult {
  const warnings: ReflowWarning[] = [];
  const idx = previous.assignments.findIndex(
    (a) => reservationKey(a.reservation) === event.reservationKey
  );
  if (idx < 0 || !isDrivingPlacement(previous.assignments[idx])) {
    warnings.push({
      level: "error",
      code: "DRIVING_CLEAR_NOT_FOUND",
      message: "해제할 드라이빙 배치를 찾을 수 없습니다.",
      reservationKey: event.reservationKey,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_CLEAR,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  const removed = previous.assignments[idx];
  if (String(removed.reservation.shift) !== "3부") {
    warnings.push({
      level: "error",
      code: "DRIVING_SHIFT_REQUIRED",
      message: "드라이빙 해제는 3부에서만 처리할 수 있습니다.",
      reservationKey: event.reservationKey,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_CLEAR,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }

  const third = thirdShiftRows(previous.assignments);
  const targetIndex = third.findIndex(
    (row) => reservationKey(row.reservation) === event.reservationKey
  );
  if (targetIndex < 0) {
    warnings.push({
      level: "error",
      code: "DRIVING_CLEAR_NOT_FOUND",
      message: "해제할 드라이빙 배치를 찾을 수 없습니다.",
      reservationKey: event.reservationKey,
    });
    return {
      date: previous.date,
      reason: REASON.DRIVING_CLEAR,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }

  const nextThird = third.map(cloneAssignmentRow);
  const chainIdxs = unlockedRegularChainIndexes(third, targetIndex);
  const incoming: AutoAssignCaddy[] = [
    ...chainIdxs.slice(1).map((i) => third[i]!.caddy),
    ...thirdSpareCaddies(previous, pool),
  ];
  const dropped: UnassignedReservationRow[] = [];
  for (let k = 0; k < chainIdxs.length; k += 1) {
    const destIdx = chainIdxs[k]!;
    const person = incoming[k];
    if (person) {
      nextThird[destIdx] = placeRegularCaddy(
        third[destIdx]!,
        person,
        `${person.name} 순번 이동`
      );
    } else {
      dropped.push({
        reservation: { ...third[destIdx]!.reservation },
        reason: REASON.DRIVING_CLEAR,
      });
    }
  }
  const keptThird = nextThird.filter((_, i) => {
    const chainPos = chainIdxs.indexOf(i);
    if (chainPos < 0) return true;
    return Boolean(incoming[chainPos]);
  });
  const leftoverIncoming = incoming.slice(chainIdxs.length);
  const after = scopedThirdBoard({
    previous,
    nextThird: keptThird,
    unassignedReservations: [
      ...cloneUnassigned(previous.unassignedReservations),
      ...dropped,
    ],
    extraUnused: [{ ...removed.caddy }, ...leftoverIncoming],
    thirdSparePeople: [...leftoverIncoming, ...previous.unusedCaddies],
  });
  return resultFromScopedBoard(
    previous,
    after,
    pool,
    REASON.DRIVING_CLEAR,
    warnings
  );
}

function applyLockOnly(
  previous: AutoAssignResultV1,
  event: Extract<ReservationChangeEvent, { type: "SET_LOCK" }>,
  pool: AutoAssignCaddy[]
): RegularReflowResult {
  const warnings: ReflowWarning[] = [];
  const idx = previous.assignments.findIndex(
    (a) => reservationKey(a.reservation) === event.reservationKey
  );
  if (idx < 0) {
    warnings.push({
      level: "error",
      code: "LOCK_TARGET_NOT_FOUND",
      message: "LOCK 대상 예약을 찾을 수 없습니다.",
      reservationKey: event.reservationKey,
    });
    return {
      date: previous.date,
      reason: REASON.LOCK_SET,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  const afterAssignments = previous.assignments.map((row, i) =>
    i === idx ? { ...cloneAssignmentRow(row), locked: event.locked } : cloneAssignmentRow(row)
  );
  const buckets = bucketizeAssignments(afterAssignments);
  const after: AutoAssignResultV1 = {
    ...previous,
    ...buckets,
    assignments: afterAssignments,
  };
  const lockedPreserved = afterAssignments.filter(isPlacementLocked).map((row) => ({
    reservationKey: reservationKey(row.reservation),
    caddy: row.caddy,
    kind: row.kind,
    reason: row.reason,
  }));
  const lockedKeys = new Set(lockedPreserved.map((r) => r.reservationKey));
  return {
    date: previous.date,
    reason: REASON.LOCK_SET,
    before: previous,
    after,
    changes: [],
    placementDiffs: buildPlacementDiffs(previous, after, lockedKeys),
    lockedPreserved,
    warnings,
    unavailableCaddyIds: [],
    summary: summarizeChanges([], lockedPreserved.length, lockedPreserved.length),
  };
}

function applySwapOnly(
  previous: AutoAssignResultV1,
  event: Extract<ReservationChangeEvent, { type: "SWAP_CADDY" }>,
  pool: AutoAssignCaddy[]
): RegularReflowResult {
  const warnings: ReflowWarning[] = [];
  const assignments = previous.assignments.map(cloneAssignmentRow);
  const ia = assignments.findIndex(
    (a) => reservationKey(a.reservation) === event.reservationKeyA
  );
  const ib = assignments.findIndex(
    (a) => reservationKey(a.reservation) === event.reservationKeyB
  );
  if (ia < 0 || ib < 0) {
    warnings.push({
      level: "error",
      code: "SWAP_TARGET_NOT_FOUND",
      message: "순번 바꿈 대상 예약을 찾을 수 없습니다.",
    });
    return {
      date: previous.date,
      reason: REASON.CADDY_SWAP,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  if (
    isDrivingPlacement(assignments[ia]) && isPlacementLocked(assignments[ia]) ||
    isDrivingPlacement(assignments[ib]) && isPlacementLocked(assignments[ib])
  ) {
    warnings.push({
      level: "error",
      code: "SWAP_DRIVING_LOCKED",
      message: "드라이빙 LOCK ON 배치는 순번 바꿈할 수 없습니다. 먼저 드라이빙을 해제하세요.",
    });
    return {
      date: previous.date,
      reason: REASON.CADDY_SWAP,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [],
      summary: emptyReflowSummary(0),
    };
  }
  const caddyA = assignments[ia].caddy;
  const caddyB = assignments[ib].caddy;
  assignments[ia] = { ...assignments[ia], caddy: { ...caddyB } };
  assignments[ib] = { ...assignments[ib], caddy: { ...caddyA } };
  const sorted = assignments.sort(compareAssignmentOrder);
  const buckets = bucketizeAssignments(sorted);
  const after: AutoAssignResultV1 = {
    ...previous,
    ...buckets,
    assignments: sorted,
  };
  const changes = buildCaddyChanges(
    previous.assignments,
    sorted,
    pool
  ).filter(
    (c) =>
      c.caddy.id === caddyA.id ||
      c.caddy.id === caddyB.id
  );
  const lockedPreserved = sorted
    .filter(isPlacementLocked)
    .map((row) => ({
      reservationKey: reservationKey(row.reservation),
      caddy: row.caddy,
      kind: row.kind,
      reason: row.reason,
    }));
  const lockedKeys = new Set(lockedPreserved.map((r) => r.reservationKey));
  return {
    date: previous.date,
    reason: REASON.CADDY_SWAP,
    before: previous,
    after,
    changes,
    placementDiffs: buildPlacementDiffs(previous, after, lockedKeys),
    lockedPreserved,
    warnings,
    unavailableCaddyIds: [],
    summary: summarizeChanges(changes, lockedPreserved.length, lockedPreserved.length),
  };
}

/**
 * 일반 예약 캔슬/추가/병가/체인지 후 순번 재계산.
 * - 예약 취소/팀 노쇼: reservation 제거, 그 캐디부터 이후 일반이 남은 슬롯으로 뒤로 밀림.
 * - 병가/결근: reservation 유지, 해당 캐디 제외, 뒤 일반이 앞으로 당김.
 * - 2부/3부 병가는 이전 부 regular identity를 freeze하고 해당 부부터 재계산.
 * LOCK ON placement는 같은 reservation에 고정하고 건너뛴다.
 * LOCK된 reservation 자체 취소는 그 placement만 제거하고 다른 LOCK은 이동시키지 않는다.
 * assignRegularSequence(Mode A/B · Spare · THIRD)를 source of truth로 재사용.
 * teamOrder / 캐디 DB 순번은 변경하지 않음.
 */
function freezeBeforeShiftFromEvents(
  events: ReservationChangeEvent[],
  previous: AutoAssignResultV1
): ShiftPart | null {
  if (
    events.some(
      (e) => e.type === "CANCEL_RESERVATION" || e.type === "ADD_RESERVATION"
    )
  ) {
    return null;
  }
  let minRank = 99;
  let any = false;
  for (const event of events) {
    if (event.type === "REMOVE_CADDY") {
      any = true;
      minRank = Math.min(
        minRank,
        shiftRank(
          removeCaddyEffectiveFromShift(event.fromShift)
        )
      );
      continue;
    }
    if (event.type !== "MOVE_RESERVATION") continue;
    const dest = parseMoveEventDestination(event.to);
    const source = findMoveSourceRow(previous, event);
    const fromShift = parseAssignShiftPart(
      source?.shift || source?.reservation.shift
    );
    const toShift = dest?.shift ?? null;
    const earliest =
      fromShift && toShift
        ? shiftRank(fromShift) <= shiftRank(toShift)
          ? fromShift
          : toShift
        : fromShift || toShift;
    if (!earliest) continue;
    any = true;
    minRank = Math.min(minRank, shiftRank(earliest));
  }
  if (!any) return null;
  if (minRank <= 0 || minRank > 2) return null;
  return SHIFT_PARTS[minRank];
}

function shiftUsesCaddy(
  previous: AutoAssignResultV1,
  shift: ShiftPart,
  caddyId: number
): boolean {
  if (
    previous.assignments.some(
      (row) => row.shift === shift && row.caddy.id === caddyId
    )
  ) {
    return true;
  }
  const spare = (previous.sparesByShift || []).find((row) => row.shift === shift);
  return (
    spare?.spare1?.caddyId === caddyId || spare?.spare2?.caddyId === caddyId
  );
}

/**
 * 1부/2부 REMOVE_CADDY가 3부 board에 없어도 3부를 통째로 재계산하지는 않는다.
 * HOUSE leftover 구간과 HOUSE spare는 assignRemoveOnlyKeepingShiftOrder가
 * refillFrozenThirdHouseLeftover로 새 remaining을 반영한다.
 *
 * 1·2부는 하나의 원형 HOUSE 큐다. 1부만 빠진 경우 2부를 동결하면
 * 1부 추가 소비가 2부 시작점으로 전달되지 않고, freeze 예약이 seedMap에서
 * 빠져 2부를 재배치할 수도 없다. 2부는 1·2 모두 안 건드린 때만 동결한다.
 */
function freezeShiftsWithoutRemovedCaddies(
  previous: AutoAssignResultV1,
  events: ReservationChangeEvent[]
): ShiftPart[] {
  if (events.length === 0 || events.some((event) => event.type !== "REMOVE_CADDY")) {
    return [];
  }
  const ids = events.map((event) => event.caddyId);
  const used1 = ids.some((id) => shiftUsesCaddy(previous, "1부", id));
  const used2 = ids.some((id) => shiftUsesCaddy(previous, "2부", id));
  const used3 = ids.some((id) => shiftUsesCaddy(previous, "3부", id));
  const freeze: ShiftPart[] = [];
  if (!used1) freeze.push("1부");
  if (!used1 && !used2) freeze.push("2부");
  if (!used3) freeze.push("3부");
  return freeze;
}

/**
 * SICK removeOnly용 원형 HOUSE 큐.
 * 1부 regular 보드 순서 + 1부 spare + 보드 leftover를 origin으로 유지한다.
 * leftover unused는 당일 snapshot(previous.unusedCaddies)에서만 붙인다.
 * recoverComputePool / DB ACTIVE extra(board·unused에 없는 pool HOUSE)는 tail로 쓰지 않는다.
 * pool 밖의 OFF/SICK/unavailable/RETIRED는 allow-map에서 걸러진다.
 * 큐[0]이 이미 1부 origin이므로 재회전하지 않는다.
 */
function circularHouseFromBoardAndCanonical(
  previous: AutoAssignResultV1,
  pool: AutoAssignCaddy[]
): AutoAssignCaddy[] {
  const allow = new Map(pool.map((caddy) => [caddy.id, caddy]));
  const ordered: AutoAssignCaddy[] = [];
  const seen = new Set<number>();
  const push = (caddy: AutoAssignCaddy | null | undefined) => {
    if (!caddy || !allow.has(caddy.id) || seen.has(caddy.id)) return;
    seen.add(caddy.id);
    ordered.push(allow.get(caddy.id) || caddy);
  };
  const rows = previous.assignments
    .filter(
      (row) =>
        row.shift === "1부" &&
        row.kind === "regular" &&
        isHouseRegularCaddy(row.caddy)
    )
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  for (const row of rows) push(row.caddy);
  const shift1Spare = (previous.sparesByShift || []).find((row) => row.shift === "1부");
  for (const slot of [shift1Spare?.spare1, shift1Spare?.spare2]) {
    if (!slot?.caddyId) continue;
    push(allow.get(slot.caddyId));
  }
  const onBoard = new Set<number>();
  for (const row of previous.assignments) {
    if (row.kind === "regular" && isHouseRegularCaddy(row.caddy)) {
      onBoard.add(row.caddy.id);
    }
  }
  for (const row of previous.sparesByShift || []) {
    if (row.spare1?.caddyId) onBoard.add(row.spare1.caddyId);
    if (row.spare2?.caddyId) onBoard.add(row.spare2.caddyId);
  }
  for (const caddy of splitCaddyPools(pool).house) {
    if (onBoard.has(caddy.id)) push(caddy);
  }
  const unusedHouse = (previous.unusedCaddies || []).filter(isHouseRegularCaddy);
  const unusedIds = new Set(unusedHouse.map((caddy) => caddy.id));
  // Pool HOUSE that are on neither the board nor unused snapshot exist
  // only because recoverComputePool merged roster/SoT extras.
  const poolHasRecoverExtras = splitCaddyPools(pool).house.some(
    (caddy) => !onBoard.has(caddy.id) && !unusedIds.has(caddy.id)
  );
  if (!poolHasRecoverExtras) {
    for (const caddy of unusedHouse) push(caddy);
  }
  return ordered;
}

function emptyRegularSequenceResult(): ReturnType<typeof assignRegularSequence> {
  return {
    assignments: [],
    unassignedReservations: [],
    specialUnassigned: [],
    finalPointer: 0,
    byShift: emptyShiftMeta(),
    sparesByShift: [],
  };
}

function isHouseRegularCaddy(caddy: AutoAssignCaddy): boolean {
  if (isThirdBandTeam(caddy.team)) return false;
  return normalizeAssignCaddyType(caddy.caddyType) === "HOUSE";
}

/**
 * 1·2부 소비 이후 3부에 들어가는 HOUSE leftover 큐.
 * Mode A: 원번 미완주 → 2부 spare HOUSE → 미근무 → wrap.
 * Mode B: 원번 완주 → 1부 미근무 ∩ 2부 실근무 (1부 spare1·2 제외) → wrap.
 */
function thirdHouseLeftoverQueue(input: {
  house: AutoAssignCaddy[];
  assignments: AutoAssignmentRow[];
  sparesByShift: SpareByShift[];
  excludeIds?: Iterable<number>;
}): AutoAssignCaddy[] {
  const excluded = new Set(input.excludeIds || []);
  const known = new Set<number>();
  for (const row of input.assignments) {
    if (isHouseRegularCaddy(row.caddy)) known.add(row.caddy.id);
  }
  for (const spare of input.sparesByShift) {
    if (spare.spare1?.caddyId) known.add(spare.spare1.caddyId);
    if (spare.spare2?.caddyId) known.add(spare.spare2.caddyId);
  }
  const house = input.house.filter(
    (caddy) => known.has(caddy.id) && !excluded.has(caddy.id)
  );
  const houseIds = new Set(house.map((caddy) => caddy.id));
  const workedShift1 = new Set<number>();
  const workedShift2 = new Set<number>();
  for (const row of input.assignments) {
    if (!houseIds.has(row.caddy.id) || !isHouseRegularCaddy(row.caddy)) continue;
    if (row.shift === "1부") workedShift1.add(row.caddy.id);
    else if (row.shift === "2부") workedShift2.add(row.caddy.id);
  }
  const worked12 = new Set<number>([...workedShift1, ...workedShift2]);
  const neverWorked = house.filter((caddy) => !worked12.has(caddy.id));
  const seen = new Set<number>();
  const ordered: AutoAssignCaddy[] = [];
  const push = (caddy: AutoAssignCaddy | undefined) => {
    if (!caddy || !houseIds.has(caddy.id) || seen.has(caddy.id)) return;
    seen.add(caddy.id);
    ordered.push(caddy);
  };
  if (neverWorked.length > 0) {
    for (const caddy of shift2SpareCaddiesFromSpares(house, input.sparesByShift)) {
      push(caddy);
    }
    for (const caddy of neverWorked) push(caddy);
    for (const caddy of house) {
      if (worked12.has(caddy.id)) push(caddy);
    }
    return ordered;
  }
  const shift1Spare = input.sparesByShift.find((row) => row.shift === "1부");
  const exclude = new Set<number>();
  if (shift1Spare?.spare1?.caddyId != null) exclude.add(shift1Spare.spare1.caddyId);
  if (shift1Spare?.spare2?.caddyId != null) exclude.add(shift1Spare.spare2.caddyId);
  for (const caddy of house) {
    if (
      !workedShift1.has(caddy.id) &&
      workedShift2.has(caddy.id) &&
      !exclude.has(caddy.id)
    ) {
      push(caddy);
    }
  }
  for (const caddy of house) push(caddy);
  return ordered;
}

/**
 * REMOVE_CADDY가 3부 board에 없으면 freezeShiftsWithoutRemovedCaddies가 3부를 동결한다.
 * 1·3 / WEEKEND / regular THIRD / 고정·특수 슬롯은 유지하고,
 * HOUSE leftover 구간과 HOUSE spare만 새 1·2부 remaining으로 다시 채운다.
 */
function refillFrozenThirdHouseLeftover(input: {
  house: AutoAssignCaddy[];
  assignments: AutoAssignmentRow[];
  sparesByShift: SpareByShift[];
  excludeIds?: Iterable<number>;
}): {
  assignments: AutoAssignmentRow[];
  sparesByShift: SpareByShift[];
} {
  const houseSlots = input.assignments
    .filter(
      (row) =>
        row.shift === "3부" &&
        row.kind === "regular" &&
        isHouseRegularCaddy(row.caddy)
    )
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  if (houseSlots.length === 0) {
    return {
      assignments: input.assignments,
      sparesByShift: input.sparesByShift,
    };
  }
  const keepIds = new Set(
    input.assignments
      .filter(
        (row) =>
          row.shift === "3부" &&
          !(
            row.kind === "regular" &&
            isHouseRegularCaddy(row.caddy)
          )
      )
      .map((row) => row.caddy.id)
  );
  const leftover = thirdHouseLeftoverQueue({
    house: input.house,
    assignments: input.assignments,
    sparesByShift: input.sparesByShift,
    excludeIds: input.excludeIds,
  }).filter((caddy) => !keepIds.has(caddy.id));
  const nextByKey = new Map<string, AutoAssignCaddy>();
  const used = new Set(keepIds);
  let cursor = 0;
  for (const slot of houseSlots) {
    while (cursor < leftover.length && used.has(leftover[cursor].id)) cursor += 1;
    const next = leftover[cursor];
    if (!next) break;
    cursor += 1;
    used.add(next.id);
    nextByKey.set(reservationKey(slot.reservation), next);
  }
  const assignments = input.assignments.map((row) => {
    if (
      row.shift !== "3부" ||
      row.kind !== "regular" ||
      !isHouseRegularCaddy(row.caddy)
    ) {
      return row;
    }
    const next = nextByKey.get(reservationKey(row.reservation));
    if (!next) return row;
    return {
      ...cloneAssignmentRow(row),
      caddy: next,
    };
  });
  const usedThird = new Set(
    assignments.filter((row) => row.shift === "3부").map((row) => row.caddy.id)
  );
  const spareQueue = leftover.filter((caddy) => !usedThird.has(caddy.id));
  const spares = pickCircularHouseSpares(spareQueue, 0, usedThird);
  const sparesByShift = input.sparesByShift.map((row) =>
    row.shift === "3부"
      ? { shift: "3부" as const, spare1: spares.spare1, spare2: spares.spare2 }
      : row
  );
  if (!sparesByShift.some((row) => row.shift === "3부")) {
    sparesByShift.push({
      shift: "3부",
      spare1: spares.spare1,
      spare2: spares.spare2,
    });
  }
  return { assignments, sparesByShift };
}

/**
 * 병가 유효 시작 부 = 사용자가 클릭한 부.
 * 1·2 regular HOUSE 투대기라도 2부 클릭을 1부로 승격하지 않는다.
 * 앞선 근무는 소급 삭제하지 않는다. (54홀 / oneTwo / oneThree 는 여기 범위 밖)
 */
function removeCaddyEffectiveFromShift(eventFrom?: ShiftPart): ShiftPart {
  return eventFrom ?? "1부";
}

function assignRemoveOnlyKeepingShiftOrder(input: {
  date: string;
  previous: AutoAssignResultV1;
  house: AutoAssignCaddy[];
  third: AutoAssignCaddy[];
  regularReservations: AutoAssignReservation[];
  reasonCode: string;
  freezeShifts: ShiftPart[];
  seedAssignments: AutoAssignmentRow[];
  seedSparesByShift: SpareByShift[];
  unavailableFromShift: Map<number, ShiftPart>;
  houseStartCaddyId?: number | null;
  thirdStartTeam: string;
  thirdStartCaddyId: number | null;
  thirdRoster: AutoAssignCaddy[];
  oneThreeForThird: AutoAssignCaddy[];
  specialSupportByShift: Record<ShiftPart, AutoAssignCaddy[]>;
  occupiedAssignments: AutoAssignmentRow[];
}): ReturnType<typeof assignRegularSequence> {
  const freezeSet = new Set(input.freezeShifts);
  const combined = emptyRegularSequenceResult();
  combined.assignments = [...input.seedAssignments];
  combined.sparesByShift = [...input.seedSparesByShift];
  const circular = {
    house: input.house,
    third: input.third,
  };
  const freeze1And2 = freezeSet.has("1부") && freezeSet.has("2부");
  if (!freeze1And2) {
    const freeze12: ShiftPart[] = freezeSet.has("1부") ? ["1부"] : [];
    const seq = assignRegularSequence({
      date: input.date,
      house: circular.house,
      third: circular.third,
      reservations: input.regularReservations.filter(
        (row) => row.shift === "1부" || row.shift === "2부"
      ),
      reasonCode: input.reasonCode,
      houseStartCaddyId: input.houseStartCaddyId ?? null,
      thirdStartTeam: input.thirdStartTeam,
      thirdStartCaddyId: null,
      thirdRoster: input.thirdRoster,
      oneThreeForThird: [],
      seedAssignments: input.seedAssignments.filter((row) =>
        freeze12.includes(row.shift)
      ),
      freezeShifts: freeze12,
      seedSparesByShift: input.seedSparesByShift.filter((row) =>
        freeze12.includes(row.shift)
      ),
      unavailableFromShift: input.unavailableFromShift,
      specialSupportByShift: input.specialSupportByShift,
      occupiedAssignments: input.occupiedAssignments.filter(
        (row) => row.shift === "1부" || row.shift === "2부"
      ),
    });
    combined.assignments = [
      ...combined.assignments.filter(
        (row) => row.shift !== "1부" && row.shift !== "2부"
      ),
      ...seq.assignments.filter((row) => row.shift === "1부" || row.shift === "2부"),
    ];
    combined.sparesByShift = [
      ...combined.sparesByShift.filter(
        (row) => row.shift !== "1부" && row.shift !== "2부"
      ),
      ...seq.sparesByShift.filter((row) => row.shift === "1부" || row.shift === "2부"),
    ];
    combined.unassignedReservations.push(
      ...seq.unassignedReservations.filter(
        (row) => row.reservation.shift === "1부" || row.reservation.shift === "2부"
      )
    );
    combined.specialUnassigned.push(...seq.specialUnassigned);
    combined.byShift["1부"] = seq.byShift["1부"];
    combined.byShift["2부"] = seq.byShift["2부"];
    combined.finalPointer = seq.finalPointer;
  } else {
    for (const shift of ["1부", "2부"] as const) {
      const seeded = input.seedAssignments.filter((row) => row.shift === shift);
      combined.byShift[shift].reservations = seeded.length;
      combined.byShift[shift].assigned = seeded.length;
    }
  }
  if (freezeSet.has("3부")) {
    const excludeIds: number[] = [];
    for (const [caddyId, from] of input.unavailableFromShift.entries()) {
      if (shiftRank("3부") >= shiftRank(from)) excludeIds.push(caddyId);
    }
    const refilled = refillFrozenThirdHouseLeftover({
      house: circular.house,
      assignments: combined.assignments,
      sparesByShift: combined.sparesByShift,
      excludeIds,
    });
    combined.assignments = refilled.assignments;
    combined.sparesByShift = refilled.sparesByShift;
    const seeded = input.seedAssignments.filter((row) => row.shift === "3부");
    combined.byShift["3부"].reservations = seeded.length;
    combined.byShift["3부"].assigned = seeded.length;
  } else {
    const seq3 = assignRegularSequence({
      date: input.date,
      house: circular.house,
      third: circular.third,
      reservations: input.regularReservations.filter((row) => row.shift === "3부"),
      reasonCode: input.reasonCode,
      houseStartCaddyId: input.houseStartCaddyId ?? null,
      thirdStartTeam: input.thirdStartTeam,
      thirdStartCaddyId: input.thirdStartCaddyId,
      thirdRoster: input.thirdRoster,
      oneThreeForThird: input.oneThreeForThird,
      seedAssignments: combined.assignments.filter(
        (row) => row.shift === "1부" || row.shift === "2부"
      ),
      freezeShifts: ["1부", "2부"],
      seedSparesByShift: combined.sparesByShift.filter(
        (row) => row.shift === "1부" || row.shift === "2부"
      ),
      unavailableFromShift: input.unavailableFromShift,
      specialSupportByShift: input.specialSupportByShift,
      occupiedAssignments: input.occupiedAssignments.filter(
        (row) => row.shift === "3부"
      ),
    });
    combined.assignments = [
      ...combined.assignments.filter((row) => row.shift !== "3부"),
      ...seq3.assignments.filter((row) => row.shift === "3부"),
    ];
    combined.sparesByShift = [
      ...combined.sparesByShift.filter((row) => row.shift !== "3부"),
      ...seq3.sparesByShift.filter((row) => row.shift === "3부"),
    ];
    combined.unassignedReservations.push(...seq3.unassignedReservations);
    combined.specialUnassigned.push(...seq3.specialUnassigned);
    combined.byShift["3부"] = seq3.byShift["3부"];
    combined.finalPointer = seq3.finalPointer;
  }
  return combined;
}

function collectShift1SpecialCandidates(
  previous: AutoAssignResultV1,
  kind: "oneThree" | "oneMak"
): AutoAssignCaddy[] {
  const seen = new Set<number>();
  const out: AutoAssignCaddy[] = [];
  for (const row of previous.assignments || []) {
    if (row.shift !== "1부" || row.kind !== kind) continue;
    if (row.locked === true) continue;
    if (seen.has(row.caddy.id)) continue;
    seen.add(row.caddy.id);
    out.push(row.caddy);
  }
  return out.sort(compareSpecialCandidateOrder);
}

function uniqueReservations(
  rows: AutoAssignReservation[]
): AutoAssignReservation[] {
  const seen = new Set<string>();
  const out: AutoAssignReservation[] = [];
  for (const row of rows) {
    const key = reservationKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function reflowPlacementPolicy(
  input: { specialPlacement?: SpecialPlacementState | null },
  previous: AutoAssignResultV1
): SpecialPlacementState {
  const src = input.specialPlacement?.mode
    ? input.specialPlacement
    : previous.specialPlacement?.mode
      ? previous.specialPlacement
      : null;
  if (src?.mode) {
    return {
      mode: src.mode,
      protectedTailCount: src.protectedTailCount,
      window: src.window ? { ...src.window } : undefined,
      block: src.block,
    };
  }
  return {
    mode: inferComputePlacementMode({
      placementMode: null,
      hasAnchor: false,
    }),
    protectedTailCount: PROTECTED_TAIL_COUNT_DEFAULT,
  };
}

export function serializeUnavailableFromShift(
  map: Map<number, ShiftPart>
): UnavailableFromShiftRow[] {
  return [...map.entries()]
    .filter(([caddyId]) => Number.isInteger(caddyId) && caddyId > 0)
    .map(([caddyId, effectiveFromShift]) => ({
      caddyId,
      effectiveFromShift,
    }));
}

function seedUnavailableFromPrevious(previous: AutoAssignResultV1): {
  unavailable: Map<number, CaddyUnavailableCause>;
  unavailableFromShift: Map<number, ShiftPart>;
  allDayUnavailable: Set<number>;
} {
  const unavailable = new Map<number, CaddyUnavailableCause>();
  const unavailableFromShift = new Map<number, ShiftPart>();
  const allDayUnavailable = new Set<number>();
  const fromRows =
    previous.unavailableFromShift && previous.unavailableFromShift.length > 0
      ? previous.unavailableFromShift
      : [];
  for (const row of fromRows) {
    const id = Number(row.caddyId);
    if (!Number.isInteger(id) || id < 1) continue;
    const from = parseAssignShiftPart(row.effectiveFromShift) ?? "1부";
    unavailable.set(id, "SICK");
    unavailableFromShift.set(id, from);
    if (from === "1부") allDayUnavailable.add(id);
  }
  for (const rawId of previous.unavailableCaddyIds || []) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1 || unavailable.has(id)) continue;
    unavailable.set(id, "SICK");
    unavailableFromShift.set(id, "1부");
    allDayUnavailable.add(id);
  }
  return { unavailable, unavailableFromShift, allDayUnavailable };
}

export function reflowRegularAssignments(input: {
  previous: AutoAssignResultV1;
  /** 원본 일반 available 풀 (정렬 전/후 모두 허용 — 내부에서 재정렬) */
  regularCaddyPool: AutoAssignCaddy[];
  events: ReservationChangeEvent[];
  specialPlacement?: SpecialPlacementState | null;
  /** 서버에서 다시 읽은 특수지원 큐. caddyPool에 넣지 않는다. */
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
}): RegularReflowResult {
  let previous = input.previous;
  const date = previous.date;
  let events = input.events || [];
  const warnings: ReflowWarning[] = [];
  const fullPool = dedupeCaddies([...(input.regularCaddyPool || [])]);

  const swapEvents = events.filter(
    (e): e is Extract<ReservationChangeEvent, { type: "SWAP_CADDY" }> =>
      e.type === "SWAP_CADDY"
  );
  const limoEvents = events.filter(
    (e): e is Extract<ReservationChangeEvent, { type: "SET_LIMOUSINE" }> =>
      e.type === "SET_LIMOUSINE"
  );
  const drivingAssignEvents = events.filter(
    (e): e is Extract<ReservationChangeEvent, { type: "ASSIGN_DRIVING" }> =>
      e.type === "ASSIGN_DRIVING"
  );
  const drivingClearEvents = events.filter(
    (e): e is Extract<ReservationChangeEvent, { type: "CLEAR_DRIVING" }> =>
      e.type === "CLEAR_DRIVING"
  );
  const lockEvents = events.filter(
    (e): e is Extract<ReservationChangeEvent, { type: "SET_LOCK" }> =>
      e.type === "SET_LOCK"
  );
  let moveEvents = events.filter(
    (e): e is Extract<ReservationChangeEvent, { type: "MOVE_RESERVATION" }> =>
      e.type === "MOVE_RESERVATION"
  );
  if (swapEvents.length > 0 && events.every((e) => e.type === "SWAP_CADDY")) {
    return applySwapOnly(previous, swapEvents[0], fullPool);
  }
  if (limoEvents.length > 0 && events.every((e) => e.type === "SET_LIMOUSINE")) {
    return applyLimousineOnly(previous, limoEvents[0], fullPool);
  }
  if (
    drivingAssignEvents.length > 0 &&
    events.every((e) => e.type === "ASSIGN_DRIVING")
  ) {
    return applyDrivingAssign(previous, drivingAssignEvents[0], fullPool);
  }
  if (
    drivingClearEvents.length > 0 &&
    events.every((e) => e.type === "CLEAR_DRIVING")
  ) {
    return applyDrivingClear(previous, drivingClearEvents[0], fullPool);
  }
  if (lockEvents.length > 0 && events.every((e) => e.type === "SET_LOCK")) {
    return applyLockOnly(previous, lockEvents[0], fullPool);
  }
  if (moveEvents.length > 0) {
    const stabilized = stabilizeMoveReservationIdentities(previous, events);
    previous = stabilized.previous;
    events = stabilized.events;
    moveEvents = events.filter(
      (e): e is Extract<ReservationChangeEvent, { type: "MOVE_RESERVATION" }> =>
        e.type === "MOVE_RESERVATION"
    );
    const moveWarnings = validateReservationMoveEvents(previous, moveEvents);
    warnings.push(...moveWarnings);
    if (moveWarnings.some((w) => w.level === "error")) {
      return {
        date: previous.date,
        reason: REASON.RESERVATION_MOVE_REFLOW,
        before: previous,
        after: previous,
        changes: [],
        placementDiffs: [],
        lockedPreserved: [],
        warnings,
        unavailableCaddyIds: [],
        summary: emptyReflowSummary(0),
      };
    }
  }
  if (swapEvents.length > 0) {
    warnings.push({
      level: "warn",
      code: "SWAP_IGNORED_WITH_REFLOW",
      message: "순번 바꿈과 다른 변경을 함께 주면 순번 바꿈은 무시되고 reflow만 적용됩니다.",
    });
  }

  const unavailableState = seedUnavailableFromPrevious(previous);
  const unavailable = unavailableState.unavailable;
  const unavailableFromShift = unavailableState.unavailableFromShift;
  const allDayUnavailable = unavailableState.allDayUnavailable;
  let cancelCount = 0;
  let teamNoshowCount = 0;
  let addCount = 0;
  let removeCount = 0;
  let moveCount = 0;

  for (const event of events) {
    if (event.type === "REMOVE_CADDY") {
      removeCount += 1;
      unavailable.set(event.caddyId, event.cause);
      const from = removeCaddyEffectiveFromShift(event.fromShift);
      unavailableFromShift.set(event.caddyId, from);
      if (from === "1부") allDayUnavailable.add(event.caddyId);
    }
  }

  const blockedInShift = (caddyId: number, shift: string) => {
    const from = unavailableFromShift.get(caddyId);
    if (!from) return false;
    return shiftRank(shift) >= shiftRank(from);
  };

  const freezeBefore = freezeBeforeShiftFromEvents(events, previous);
  const freezeShifts: ShiftPart[] = [
    ...SHIFT_PARTS.filter(
      (shift) => freezeBefore && shiftRank(shift) < shiftRank(freezeBefore)
    ),
    ...freezeShiftsWithoutRemovedCaddies(previous, events),
  ].filter((shift, i, all) => all.indexOf(shift) === i);
  const removeOnly =
    events.length > 0 && events.every((event) => event.type === "REMOVE_CADDY");

  let lockedRows = previous.assignments
    .filter((row) => preservePlacementOnReflow(row) && !blockedInShift(row.caddy.id, row.shift))
    .map(cloneAssignmentRow)
    .map((row) => ({ ...row, locked: true as const }));
  const cancelledLockedKeys = new Set<string>();
  const lockedCaddies = new Set<number>([
    ...lockedRows.map((r) => r.caddy.id),
    ...fixedCancelledCaddyIds(previous),
  ]);
  const lockedResKeys = new Set(
    lockedRows.map((r) => reservationKey(r.reservation))
  );

  const unlockedPrevious = previous.assignments.filter(
    (row) => !lockedResKeys.has(reservationKey(row.reservation))
  );
  const unlockedSpecialByCaddy = new Map<number, AutoAssignmentRow>();
  for (const row of unlockedPrevious) {
    if (specialTagRow(row) && !blockedInShift(row.caddy.id, row.shift)) {
      unlockedSpecialByCaddy.set(row.caddy.id, row);
    }
  }

  const seedMap = new Map<string, AutoAssignReservation>();
  for (const a of unlockedPrevious) {
    seedMap.set(reservationKey(a.reservation), a.reservation);
  }
  for (const u of previous.unassignedReservations || []) {
    const key = reservationKey(u.reservation);
    if (lockedResKeys.has(key)) continue;
    if (!seedMap.has(key)) seedMap.set(key, u.reservation);
  }

  for (const event of events) {
    if (event.type === "CANCEL_RESERVATION") {
      const cause = event.cause === "TEAM_NOSHOW" ? "TEAM_NOSHOW" : "CANCEL";
      if (cause === "TEAM_NOSHOW") teamNoshowCount += 1;
      else cancelCount += 1;
      const keysToDelete: string[] = [];
      for (const [key, res] of seedMap.entries()) {
        if (matchesCancelEvent(res, event)) keysToDelete.push(key);
      }
      for (const key of keysToDelete) {
        seedMap.delete(key);
      }
      for (const row of lockedRows) {
        if (matchesCancelEvent(row.reservation, event)) {
          cancelledLockedKeys.add(reservationKey(row.reservation));
        }
      }
      continue;
    }
    if (event.type === "ADD_RESERVATION") {
      const res = event.reservation.date
        ? event.reservation
        : { ...event.reservation, date };
      const key = reservationKey(res);
      if (lockedResKeys.has(key) && !cancelledLockedKeys.has(key)) {
        warnings.push({
          level: "warn",
          code: "ADD_LOCKED_SLOT",
          message: "LOCK ON 특수배치 슬롯에는 추가팀을 등록할 수 없습니다.",
          reservationKey: key,
        });
        continue;
      }
      const existing = [...seedMap.values(), ...lockedRows.map((r) => r.reservation)];
      const hit = courseTeeCollision(res, existing);
      if (hit) {
        warnings.push({
          level: "error",
          code: "DUPLICATE_COURSE_TEETIME",
          message: `해당 코스/티타임에 이미 예약이 있습니다 (${courseLabelForWarning(hit.course)} ${hit.teeTime}).`,
          reservationKey: key,
        });
        continue;
      }
      addCount += 1;
      seedMap.set(key, res);
      continue;
    }
    if (event.type === "MOVE_RESERVATION") {
      moveCount += 1;
      const dest = parseMoveEventDestination(event.to);
      const sourceRow = findMoveSourceRow(previous, event);
      if (!dest || !sourceRow) continue;
      const original =
        seedMap.get(reservationKey(sourceRow.reservation)) ||
        seedMap.get(legacyCompositeReservationKey(sourceRow.reservation)) ||
        sourceRow.reservation;
      const stamped = ensureReservationUid(original);
      const nextKey = reservationKey(stamped);
      for (const oldKey of [
        reservationKey(original),
        legacyCompositeReservationKey(original),
        reservationKey(sourceRow.reservation),
      ]) {
        seedMap.delete(oldKey);
      }
      seedMap.set(nextKey, {
        ...stamped,
        course: dest.course,
        shift: dest.shift,
        teeTime: dest.teeTime,
      });
    }
  }

  const cancelledLockedSpecial = lockedRows.filter((row) =>
    cancelledLockedKeys.has(reservationKey(row.reservation))
  );
  if (cancelledLockedKeys.size > 0) {
    lockedRows = lockedRows.filter(
      (row) => !cancelledLockedKeys.has(reservationKey(row.reservation))
    );
  }

  const seedAssignments = previous.assignments
    .filter(
      (row) =>
        freezeShifts.includes(row.shift) &&
        !preservePlacementOnReflow(row) &&
        !blockedInShift(row.caddy.id, row.shift)
    )
    .map(cloneAssignmentRow);
  const frozenResKeys = new Set(
    seedAssignments.map((row) => reservationKey(row.reservation))
  );
  for (const key of frozenResKeys) seedMap.delete(key);
  const seedSparesByShift = (previous.sparesByShift || []).filter((s) =>
    freezeShifts.includes(s.shift)
  );

  const placementPolicy = reflowPlacementPolicy(input, previous);
  const shift1Frozen = freezeShifts.includes("1부");
  const autoShift1Specials: AutoAssignmentRow[] = [];
  let autoSpecialBlock: SpecialWindowBlock | undefined;
  if (placementPolicy.mode === "AUTO" && !shift1Frozen) {
    const oneThreeCands = collectShift1SpecialCandidates(previous, "oneThree");
    const oneMakCands = collectShift1SpecialCandidates(previous, "oneMak");
    const shift1All = uniqueReservations([
      ...lockedRows.map((row) => row.reservation),
      ...seedMap.values(),
    ])
      .filter((row) => row.shift === "1부")
      .sort(compareReservationOrder);
    const window = computeShift1SpecialWindow({
      N: shift1All.length,
      R: placementPolicy.protectedTailCount,
      A: oneThreeCands.length,
      B: oneMakCands.length,
    });
    if (!window.ok) {
      autoSpecialBlock = {
        code: REASON.SPECIAL_WINDOW_OVERFLOW,
        message: window.message,
        neededCount: window.neededCount,
        availableCount: window.availableCount,
        collisions: [],
      };
    } else if (window.neededCount > 0) {
      const occupied = occupancyLookup(lockedRows);
      const remainingKeys = new Set(
        [...seedMap.values()]
          .filter((row) => row.shift === "1부")
          .map(reservationKey)
      );
      const target = shift1All.slice(window.specialStart - 1, window.specialEnd);
      const collisions: SpecialWindowCollision[] = [];
      target.forEach((row, offset) => {
        const key = reservationKey(row);
        if (remainingKeys.has(key)) return;
        const hit = occupied.get(key);
        collisions.push({
          index: window.specialStart + offset,
          course: String(row.course),
          teeTime: row.teeTime,
          teamName: row.teamName ?? null,
          kind: hit?.kind,
          reason: hit?.reason,
        });
      });
      if (collisions.length) {
        autoSpecialBlock = {
          code: REASON.SPECIAL_WINDOW_COLLISION,
          message: `1·3부/1막 자동 구간에 이미 다른 특수배치가 있습니다 (${collisions
            .map(
              (c) =>
                `${c.index}번째 ${c.course} ${c.teeTime}${
                  c.kind ? ` · ${c.kind}` : ""
                }`
            )
            .join(", ")}).`,
          neededCount: window.neededCount,
          availableCount: window.availableCount,
          collisions,
        };
      } else {
        const place = (
          caddy: AutoAssignCaddy,
          slot: AutoAssignReservation,
          kind: "oneThree" | "oneMak",
          reason: string,
          pairId: string | null
        ) => {
          autoShift1Specials.push({
            date,
            shift: slot.shift as ShiftPart,
            sequenceIndex: -1,
            reason,
            reservation: slot,
            caddy,
            pairId,
            kind,
            locked: false,
          });
          seedMap.delete(reservationKey(slot));
        };
        oneThreeCands.forEach((caddy, i) =>
          place(
            caddy,
            target[i],
            "oneThree",
            REASON.ONE_THREE_PRIORITY,
            `13-${caddy.id}`
          )
        );
        oneMakCands.forEach((caddy, i) =>
          place(
            caddy,
            target[oneThreeCands.length + i],
            "oneMak",
            REASON.ONE_MAK_PRIORITY,
            null
          )
        );
        placementPolicy.window = {
          N: window.N,
          specialStart: window.specialStart,
          specialEnd: window.specialEnd,
          oneThreeStart: window.oneThreeStart,
          oneThreeEnd: window.oneThreeEnd,
          oneMakStart: window.oneMakStart,
          oneMakEnd: window.oneMakEnd,
        };
      }
    }
  }
  if (autoSpecialBlock) {
    warnings.push({
      level: "error",
      code: autoSpecialBlock.code,
      message: autoSpecialBlock.message,
    });
    return {
      date,
      reason: autoSpecialBlock.code,
      before: previous,
      after: previous,
      changes: [],
      placementDiffs: [],
      lockedPreserved: [],
      warnings,
      unavailableCaddyIds: [...unavailable.keys()],
      summary: emptyReflowSummary(0),
    };
  }

  const regularReservations = [...seedMap.values()].sort(compareReservationOrder);
  const autoSpecialIds = new Set(autoShift1Specials.map((row) => row.caddy.id));

  const extraSpecials = unlockedPrevious
    .filter(
      (row) =>
        specialTagRow(row) &&
        !allDayUnavailable.has(row.caddy.id) &&
        !blockedInShift(row.caddy.id, row.shift) &&
        !autoSpecialIds.has(row.caddy.id)
    )
    .map((row) => row.caddy);
  const remainingSource = eligibleRegularReflowCaddies([
    ...fullPool,
    ...extraSpecials,
  ]).filter(
    (c) =>
      !lockedCaddies.has(c.id) &&
      !allDayUnavailable.has(c.id) &&
      !autoSpecialIds.has(c.id)
  );
  const originalSource = eligibleRegularReflowCaddies([
    ...fullPool,
    ...extraSpecials,
    ...previous.assignments.map((row) => row.caddy),
    ...(previous.unusedCaddies || []),
  ]).filter((c) => !lockedCaddies.has(c.id) && !autoSpecialIds.has(c.id));
  // Non-SICK reflow: historical team-order rebuild + origin rotate.
  // SICK removeOnly: 1부 보드 순서 + leftover. Do not team-sort the
  // whole queue and do not rebuild 2부 from its (possibly reset) board.
  const pool = [...remainingSource].sort(compareCaddyOrder);
  const pools = splitCaddyPools(pool);
  const originalHouse = splitCaddyPools(
    [...originalSource].sort(compareCaddyOrder)
  ).house;

  const reasonCode = resolveReflowReason({
    swapCount: 0,
    cancelCount,
    teamNoshowCount,
    addCount,
    removeCount,
    moveCount,
  });

  const startId = previous.meta.houseStartCaddyId;
  let houseStartCaddyId: number | null;
  if (removeOnly) {
    pools.house = circularHouseFromBoardAndCanonical(previous, remainingSource);
    pools.third = splitCaddyPoolsPreservingOrder(remainingSource).third;
    houseStartCaddyId = null;
  } else {
    const resolvedHouse = resolveHouseQueueKeepingOrigin({
      remainingHouse: pools.house,
      originalHouse,
      houseStartCaddyId: startId,
    });
    houseStartCaddyId = resolvedHouse.houseStartCaddyId;
    pools.house = resolvedHouse.house;
  }

  const thirdStartCaddyId =
    previous.meta.thirdStartCaddyId != null
      ? Number(previous.meta.thirdStartCaddyId)
      : null;
  const thirdRoster = dedupeCaddies([
    ...fullPool,
    ...previous.assignments.map((row) => row.caddy),
    ...(previous.unusedCaddies || []),
  ]);
  const lockedThirdIds = new Set(
    lockedRows.filter((row) => row.shift === "3부").map((row) => row.caddy.id)
  );
  const oneThreeForThird: AutoAssignCaddy[] = [];
  const seenOneThree = new Set<number>();
  for (const row of [
    ...lockedRows,
    ...seedAssignments,
    ...autoShift1Specials,
  ]) {
    if (row.kind !== "oneThree" || row.shift !== "1부") continue;
    if (lockedThirdIds.has(row.caddy.id)) continue;
    if (seenOneThree.has(row.caddy.id)) continue;
    seenOneThree.add(row.caddy.id);
    oneThreeForThird.push(row.caddy);
  }

  const regular = removeOnly
    ? assignRemoveOnlyKeepingShiftOrder({
        date,
        previous,
        house: pools.house,
        third: pools.third,
        regularReservations,
        reasonCode,
        freezeShifts,
        seedAssignments,
        seedSparesByShift,
        unavailableFromShift,
        houseStartCaddyId,
        thirdStartTeam:
          previous.meta.thirdStartTeam || automaticThirdStartTeam(date),
        thirdStartCaddyId,
        thirdRoster,
        oneThreeForThird,
        specialSupportByShift:
          input.specialSupportByShift ||
          previous.specialSupportByShift ||
          emptySpecialSupportByShift(),
        occupiedAssignments: [...lockedRows, ...autoShift1Specials],
      })
    : assignRegularSequence({
        date,
        house: pools.house,
        third: pools.third,
        reservations: regularReservations,
        reasonCode,
        houseStartCaddyId,
        thirdStartTeam:
          previous.meta.thirdStartTeam || automaticThirdStartTeam(date),
        thirdStartCaddyId,
        thirdRoster,
        oneThreeForThird,
        seedAssignments,
        freezeShifts,
        seedSparesByShift,
        unavailableFromShift,
        specialSupportByShift:
          input.specialSupportByShift ||
          previous.specialSupportByShift ||
          emptySpecialSupportByShift(),
        occupiedAssignments: [...lockedRows, ...autoShift1Specials],
      });

  const regularAssignments = regular.assignments.map((row) =>
    overlaySpecialTag(row, unlockedSpecialByCaddy)
  );
  const usedRegular = new Set([
    ...regularAssignments.map((a) => a.caddy.id),
    ...autoSpecialIds,
  ]);
  const unusedCaddies = pool.filter((c) => !usedRegular.has(c.id));

  const assignments = [
    ...lockedRows,
    ...autoShift1Specials,
    ...regularAssignments,
  ].sort(compareAssignmentOrder);
  const buckets = bucketizeAssignments(assignments);

  const byShift = emptyShiftMeta();
  for (const shift of SHIFT_PARTS) {
    const lockedCount =
      lockedRows.filter((a) => a.shift === shift).length +
      autoShift1Specials.filter((a) => a.shift === shift).length;
    byShift[shift].reservations =
      lockedCount + regular.byShift[shift].reservations;
    byShift[shift].assigned = lockedCount + regular.byShift[shift].assigned;
    byShift[shift].unassigned = regular.byShift[shift].unassigned;
  }

  const after: AutoAssignResultV1 = {
    ...previous,
    ...buckets,
    assignments,
    unassignedReservations: regular.unassignedReservations,
    closedCourseReservations: previous.closedCourseReservations || [],
    openCourses: previous.openCourses || [...COURSE_ORDER],
    unusedCaddies,
    specialUnassigned: [
      ...(previous.specialUnassigned || []),
      ...cancelledLockedSpecial
        .filter((row) => specialTagRow(row))
        .map((row) => ({
          caddy: row.caddy,
          reason: REASON.FIXED_CANCELLED,
          review: true as const,
          note: row.note ?? null,
        })),
    ],
    sparesByShift: regular.sparesByShift,
    specialSupportByShift:
      input.specialSupportByShift ||
      previous.specialSupportByShift ||
      emptySpecialSupportByShift(),
    meta: {
      ...previous.meta,
      availableCount: pool.length,
      reservationCount: lockedRows.length + regularReservations.length,
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
    specialPlacement: {
      ...placementPolicy,
      block: autoSpecialBlock,
    },
    unavailableCaddyIds: [...unavailable.keys()],
    unavailableFromShift: serializeUnavailableFromShift(unavailableFromShift),
  };

  const lockedPreserved: LockedPreservedRow[] = lockedRows.map((row) => ({
    reservationKey: reservationKey(row.reservation),
    caddy: row.caddy,
    kind: row.kind,
    reason: row.reason,
  }));
  const lockedKeys = new Set(lockedPreserved.map((r) => r.reservationKey));
  const changes = buildCaddyChanges(
    unlockedPrevious.length > 0 ? unlockedPrevious : previous.regularAssignments,
    regularAssignments,
    pool
  );

  return {
    date,
    reason: reasonCode,
    before: previous,
    after,
    changes,
    placementDiffs: buildPlacementDiffs(previous, after, lockedKeys),
    lockedPreserved,
    warnings,
    unavailableCaddyIds: [...unavailable.keys()],
    summary: summarizeChanges(
      changes,
      lockedRows.length,
      lockedPreserved.length
    ),
  };
}
