/**
 * 1·3부 / 1막 1부 위치 정책 (순수 도메인, DB write 없음).
 * AUTO: 1부 팀 순번 창. MANUAL: 기존 course+teeTime anchor.
 */

export const SPECIAL_PLACEMENT_MODES = ["AUTO", "MANUAL"] as const;
export type SpecialPlacementMode = (typeof SPECIAL_PLACEMENT_MODES)[number];

export const PROTECTED_TAIL_COUNT_DEFAULT = 4;
export const PROTECTED_TAIL_COUNT_MIN = 0;
export const PROTECTED_TAIL_COUNT_MAX = 20;

export const SPECIAL_WINDOW_OVERFLOW = "SPECIAL_WINDOW_OVERFLOW";
export const SPECIAL_WINDOW_COLLISION = "SPECIAL_WINDOW_COLLISION";

export type SpecialPlacementSetting = {
  mode: SpecialPlacementMode;
  protectedTailCount: number;
};

export type ResolvedSpecialPlacement = SpecialPlacementSetting & {
  source: "row" | "implicit-manual" | "implicit-auto" | "explicit";
};

export type SpecialWindowCollision = {
  index: number;
  course: string;
  teeTime: string;
  teamName: string | null;
  kind?: string;
  reason?: string;
};

export type Shift1SpecialWindowOk = {
  ok: true;
  N: number;
  R: number;
  A: number;
  B: number;
  S: number;
  neededCount: number;
  availableCount: number;
  specialStart: number;
  specialEnd: number;
  oneThreeStart: number | null;
  oneThreeEnd: number | null;
  oneMakStart: number | null;
  oneMakEnd: number | null;
  supportStart: number | null;
  supportEnd: number | null;
};

export type Shift1SpecialWindowFail = {
  ok: false;
  code: typeof SPECIAL_WINDOW_OVERFLOW;
  N: number;
  R: number;
  A: number;
  B: number;
  S: number;
  neededCount: number;
  availableCount: number;
  message: string;
};

export type Shift1SpecialWindow = Shift1SpecialWindowOk | Shift1SpecialWindowFail;

export function isSpecialPlacementMode(
  value: unknown
): value is SpecialPlacementMode {
  return SPECIAL_PLACEMENT_MODES.includes(String(value) as SpecialPlacementMode);
}

export function parseProtectedTailCount(
  raw: unknown
): { ok: true; value: number } | { ok: false; message: string } {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n)) {
    return { ok: false, message: "뒤 일반순번 보호 팀 수는 정수여야 합니다." };
  }
  if (n < PROTECTED_TAIL_COUNT_MIN || n > PROTECTED_TAIL_COUNT_MAX) {
    return {
      ok: false,
      message: `뒤 일반순번 보호 팀 수는 ${PROTECTED_TAIL_COUNT_MIN}~${PROTECTED_TAIL_COUNT_MAX}만 허용합니다.`,
    };
  }
  return { ok: true, value: n };
}

/** 엔진 순수 입력: 명시 모드 우선, 없으면 anchor 전달 시 MANUAL. */
export function inferComputePlacementMode(input: {
  placementMode?: SpecialPlacementMode | null;
  hasAnchor: boolean;
}): SpecialPlacementMode {
  if (input.placementMode === "AUTO" || input.placementMode === "MANUAL") {
    return input.placementMode;
  }
  return input.hasAnchor ? "MANUAL" : "AUTO";
}

/**
 * 저장 설정 해석.
 * 행 없음 + anchor 있음 → MANUAL (기존 운영일 유지).
 * 행 없음 + anchor 없음 → AUTO R=4.
 */
export function resolveStoredPlacementPolicy(input: {
  setting?: { mode?: unknown; protectedTailCount?: unknown } | null;
  hasAnchor: boolean;
}): ResolvedSpecialPlacement {
  if (input.setting && isSpecialPlacementMode(input.setting.mode)) {
    const parsed = parseProtectedTailCount(input.setting.protectedTailCount);
    return {
      mode: input.setting.mode,
      protectedTailCount: parsed.ok
        ? parsed.value
        : PROTECTED_TAIL_COUNT_DEFAULT,
      source: "row",
    };
  }
  if (input.hasAnchor) {
    return {
      mode: "MANUAL",
      protectedTailCount: PROTECTED_TAIL_COUNT_DEFAULT,
      source: "implicit-manual",
    };
  }
  return {
    mode: "AUTO",
    protectedTailCount: PROTECTED_TAIL_COUNT_DEFAULT,
    source: "implicit-auto",
  };
}

function rawNonNegativeInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

export function computeShift1SpecialWindow(input: {
  N: number;
  R: number;
  A: number;
  B: number;
  S?: number;
}): Shift1SpecialWindow {
  const N = Math.max(0, Math.floor(Number(input.N) || 0));
  // 공식은 R>=0 정수를 그대로 쓴다. 0~20 제한은 저장/API 전용.
  const R = rawNonNegativeInt(input.R, PROTECTED_TAIL_COUNT_DEFAULT);
  const A = Math.max(0, Math.floor(Number(input.A) || 0));
  const B = Math.max(0, Math.floor(Number(input.B) || 0));
  const S = Math.max(0, Math.floor(Number(input.S) || 0));
  const neededCount = A + B + S;
  const availableCount = Math.max(0, N - R);
  if (neededCount === 0) {
    return {
      ok: true,
      N,
      R,
      A,
      B,
      S,
      neededCount: 0,
      availableCount,
      specialStart: availableCount + 1,
      specialEnd: availableCount,
      oneThreeStart: null,
      oneThreeEnd: null,
      oneMakStart: null,
      oneMakEnd: null,
      supportStart: null,
      supportEnd: null,
    };
  }
  if (neededCount > availableCount) {
    return {
      ok: false,
      code: SPECIAL_WINDOW_OVERFLOW,
      N,
      R,
      A,
      B,
      S,
      neededCount,
      availableCount,
      message:
        S > 0
          ? `1·3부/1막/특수지원 ${neededCount}명을 넣을 1부 자리가 ${availableCount}칸뿐입니다 (1부 ${N}팀, 끝 ${R}팀 제외).`
          : `1·3부/1막 ${neededCount}명을 넣을 1부 자리가 ${availableCount}칸뿐입니다 (1부 ${N}팀, 끝 ${R}팀 제외).`,
    };
  }
  const specialEnd = N - R;
  const specialStart = specialEnd - neededCount + 1;
  return {
    ok: true,
    N,
    R,
    A,
    B,
    S,
    neededCount,
    availableCount,
    specialStart,
    specialEnd,
    oneThreeStart: A > 0 ? specialStart : null,
    oneThreeEnd: A > 0 ? specialStart + A - 1 : null,
    oneMakStart: B > 0 ? specialStart + A : null,
    oneMakEnd: B > 0 ? specialStart + A + B - 1 : null,
    supportStart: S > 0 ? specialStart + A + B : null,
    supportEnd: S > 0 ? specialStart + A + B + S - 1 : null,
  };
}

export function formatShift1Range(start: number | null, end: number | null): string {
  if (start == null || end == null) return "없음";
  if (start === end) return `${start}번째`;
  return `${start}~${end}번째`;
}

export type Shift1SlotPreview = {
  index: number;
  course: string;
  teeTime: string;
  teamName: string | null;
};

export function sliceShift1WindowSlots<
  T extends { course: string; teeTime: string; teamName?: string | null },
>(
  slots: readonly T[],
  start: number | null,
  end: number | null
): Shift1SlotPreview[] {
  if (start == null || end == null) return [];
  return slots.slice(start - 1, end).map((row, i) => ({
    index: start + i,
    course: row.course,
    teeTime: row.teeTime,
    teamName: row.teamName ?? null,
  }));
}
