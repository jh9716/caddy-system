/** 캐디 운영 관리 상수·검증 (DB migration 실행과 무관) */

export const PRIMARY_TEAMS = [
  "1조",
  "2조",
  "3조",
  "4조",
  "5조",
  "6조",
  "7조",
  "8조",
  "9조",
  "10조",
  "11조",
  "12조",
] as const;

export function isPrimaryTeam(team: string): boolean {
  return (PRIMARY_TEAMS as readonly string[]).includes(String(team ?? "").trim());
}

/** 3부반 조 (주중/주말 세부구분 허용) */
export const THIRD_BAND_TEAMS = ["9조", "10조", "11조", "12조"] as const;
export type ThirdBandTeam = (typeof THIRD_BAND_TEAMS)[number];

/** Prisma ThirdBandSubgroup — DRIVING 포함 금지 */
export const THIRD_BAND_SUBGROUPS = ["WEEKDAY", "WEEKEND"] as const;
export type ThirdBandSubgroup = (typeof THIRD_BAND_SUBGROUPS)[number];

export const THIRD_BAND_SUBGROUP_LABELS: Record<ThirdBandSubgroup, string> = {
  WEEKDAY: "주중",
  WEEKEND: "주말",
};

export function isThirdBandTeam(team: string): boolean {
  return (THIRD_BAND_TEAMS as readonly string[]).includes(String(team ?? "").trim());
}

/** DRIVING 전담 캐디가 쓰는 가상 조. 1~12조 고정 슬롯을 점유하지 않음. */
export const DRIVING_POOL_TEAM = "드라이빙";

export function isDrivingCaddyType(value: unknown): boolean {
  return String(value ?? "").trim().toUpperCase() === "DRIVING";
}

export function drivingPersistFields(): {
  team: string;
  teamOrder: number;
  caddyType: "DRIVING";
  thirdBandSubgroup: null;
} {
  return {
    team: DRIVING_POOL_TEAM,
    teamOrder: 0,
    caddyType: "DRIVING",
    thirdBandSubgroup: null,
  };
}

/** HOUSE/THIRD 고정 슬롯 점유 여부. DRIVING은 조/순번과 무관하게 제외. */
export function occupiesHouseThirdSlot(p: {
  caddyType?: string | null;
  team?: string | null;
}): boolean {
  if (isDrivingCaddyType(p.caddyType)) return false;
  if (String(p.team ?? "").trim() === DRIVING_POOL_TEAM) return false;
  return isPrimaryTeam(String(p.team ?? ""));
}

/** 조 기준 canonical caddyType. DRIVING은 이 헬퍼가 부여하지 않음. */
export type TeamCaddyType = "HOUSE" | "THIRD";

/**
 * 서버 canonical invariant:
 * - 1~8조 → HOUSE
 * - 9~12조 → THIRD
 * thirdBandSubgroup(일반/주중/주말)과 독립.
 */
export function resolveCaddyTypeFromTeam(team: string): TeamCaddyType {
  return isThirdBandTeam(team) ? "THIRD" : "HOUSE";
}

export class ThirdBandSubgroupError extends Error {
  status = 400;
  code = "third_band_subgroup_invalid";
  constructor(message: string) {
    super(message);
    this.name = "ThirdBandSubgroupError";
  }
}

/**
 * API 입력 정규화.
 * - undefined: 필드 미전송
 * - null / "" / "null" / "NONE" / "일반": null
 * - WEEKDAY | WEEKEND (및 한글 주중/주말): enum
 */
export function parseThirdBandSubgroupInput(
  input: unknown
): ThirdBandSubgroup | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const v = String(input).trim();
  if (v === "" || v === "null" || v.toUpperCase() === "NONE" || v === "일반") {
    return null;
  }
  const upper = v.toUpperCase();
  if (upper === "WEEKDAY" || v === "주중" || v === "주중반") return "WEEKDAY";
  if (upper === "WEEKEND" || v === "주말" || v === "주말반") return "WEEKEND";
  throw new ThirdBandSubgroupError(
    "3부반 세부구분은 일반/주중/주말만 선택할 수 있습니다."
  );
}

/**
 * Import CSV 셀 파싱.
 * - 빈칸 / 컬럼 생략 → undefined (기존 값 유지; 신규는 resolve 시 null)
 * - 일반 / NONE / "null" → null (명시적 해제)
 * - 주중·WEEKDAY·주중반 / 주말·WEEKEND·주말반 → enum
 * - DRIVING / 드라이빙 및 그 외 → throw
 */
export function parseImportThirdBandSubgroup(
  input: unknown
): ThirdBandSubgroup | null | undefined {
  if (input === undefined || input === null) return undefined;
  const v = String(input).trim();
  if (v === "") return undefined;
  return parseThirdBandSubgroupInput(v);
}

/** Export/Preview 표시: null → 일반, WEEKDAY → 주중, WEEKEND → 주말 */
export function thirdBandSubgroupCsvLabel(
  value: ThirdBandSubgroup | null | undefined
): string {
  if (value === "WEEKDAY") return THIRD_BAND_SUBGROUP_LABELS.WEEKDAY;
  if (value === "WEEKEND") return THIRD_BAND_SUBGROUP_LABELS.WEEKEND;
  return "일반";
}

/**
 * 최종 team 기준 invariant:
 * - 1~8조: 항상 null. WEEKDAY/WEEKEND 명시 요청이면 400.
 * - 9~12조: null | WEEKDAY | WEEKEND.
 * - requested === undefined → keepCurrent(없으면 null). 1~8→9~12 이동 시 keepCurrent는 보통 null.
 */
export function resolveThirdBandSubgroup(input: {
  team: string;
  requested: unknown;
  /** update 시 현재 DB 값. create면 null/undefined */
  current?: ThirdBandSubgroup | null;
}): ThirdBandSubgroup | null {
  const team = String(input.team ?? "").trim();
  const requested = parseThirdBandSubgroupInput(input.requested);

  if (!isThirdBandTeam(team)) {
    if (requested === "WEEKDAY" || requested === "WEEKEND") {
      throw new ThirdBandSubgroupError(
        "1~8조 캐디는 주중반/주말반(thirdBandSubgroup)을 가질 수 없습니다."
      );
    }
    return null;
  }

  if (requested === undefined) {
    const cur = input.current ?? null;
    if (cur === "WEEKDAY" || cur === "WEEKEND") return cur;
    return null;
  }
  return requested;
}

export const EXTRA_FLAG_OPTIONS = ["주중반", "주말반", "드라이빙"] as const;
export type ExtraFlagOption = (typeof EXTRA_FLAG_OPTIONS)[number];

/** legacy 주중/주말 — 신규 SoT는 thirdBandSubgroup. UI 편집·신규 추가 금지, DB 기존값만 보존 */
export const LEGACY_THIRD_BAND_EXTRA_FLAGS = ["주중반", "주말반"] as const;
export type LegacyThirdBandExtraFlag =
  (typeof LEGACY_THIRD_BAND_EXTRA_FLAGS)[number];

/** 관리자 UI에서만 편집 가능한 extraFlags (주중반/주말반 제외) */
export const EDITABLE_EXTRA_FLAG_OPTIONS = ["드라이빙"] as const;
export type EditableExtraFlagOption =
  (typeof EDITABLE_EXTRA_FLAG_OPTIONS)[number];

export function isLegacyThirdBandExtraFlag(
  value: string
): value is LegacyThirdBandExtraFlag {
  return (LEGACY_THIRD_BAND_EXTRA_FLAGS as readonly string[]).includes(value);
}

/**
 * create: 주중반/주말반 신규 저장 금지 (incoming에서 제거).
 * update: incoming의 주중반/주말반은 무시하고, DB에 있던 주중반/주말반만 보존·재합류.
 * 그 외(드라이빙 등)는 incoming 기준.
 */
export function mergeExtraFlagsForPersist(input: {
  incoming: unknown;
  current?: string[] | null;
  mode: "create" | "update";
}): ExtraFlagOption[] {
  const incomingEditable = normalizeExtraFlags(input.incoming).filter(
    (f) => !isLegacyThirdBandExtraFlag(f)
  );
  if (input.mode === "create") {
    return incomingEditable;
  }
  const preservedLegacy = normalizeExtraFlags(input.current ?? []).filter(
    isLegacyThirdBandExtraFlag
  );
  return normalizeExtraFlags([...incomingEditable, ...preservedLegacy]);
}

/** Production DB enum values */
export const EMPLOYMENT_STATUSES = ["ACTIVE", "LEAVE", "RETIRED"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/** UI labels (DB enum ↔ 한글) */
export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  ACTIVE: "재직",
  LEAVE: "휴직",
  RETIRED: "퇴사",
};

export const TEAM_OPTIONS = [
  ...PRIMARY_TEAMS,
  ...EXTRA_FLAG_OPTIONS,
] as const;

export function isExtraFlag(value: string): value is ExtraFlagOption {
  return (EXTRA_FLAG_OPTIONS as readonly string[]).includes(value);
}

export function normalizeExtraFlags(input: unknown): ExtraFlagOption[] {
  if (!Array.isArray(input)) return [];
  const set = new Set<ExtraFlagOption>();
  for (const raw of input) {
    const v = String(raw ?? "").trim();
    if (isExtraFlag(v)) set.add(v);
  }
  return EXTRA_FLAG_OPTIONS.filter((f) => set.has(f));
}

/** Accepts DB enum or Korean labels; always returns Production enum. */
export function normalizeEmploymentStatus(input: unknown): EmploymentStatus {
  const v = String(input ?? "").trim();
  const upper = v.toUpperCase();
  if (upper === "RETIRED" || v === "퇴사") return "RETIRED";
  if (upper === "LEAVE" || v === "휴직") return "LEAVE";
  if (upper === "ACTIVE" || v === "재직") return "ACTIVE";
  return "ACTIVE";
}

export function employmentStatusLabel(input: unknown): string {
  const status = normalizeEmploymentStatus(input);
  return EMPLOYMENT_STATUS_LABELS[status];
}

export function normalizeTeamOrder(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** Query param helper: all | ACTIVE | LEAVE | RETIRED (+ Korean aliases) */
export function parseEmploymentFilter(
  input: string | null | undefined
): EmploymentStatus | "all" {
  const raw = String(input ?? "ACTIVE").trim();
  if (raw === "all" || raw === "ALL" || raw === "전체") return "all";
  return normalizeEmploymentStatus(raw);
}
