/**
 * 캐디 명단 import 규칙 (DB/스키마 변경 없음)
 *
 * 스키마 호환 제안 (migration/db push 하지 않음 — Preview만):
 * - 기존 Caddy.team 유지: primary 소속 문자열
 *   - 1~12조 배정자: team = primaryTeam (예: "5조")
 *   - extra-only: team = 해당 분류 (예: "주중반") — 현행 UI/가용표와 호환
 * - 추후 additive 필드 제안 (미적용):
 *   - Caddy.extraFlags String[] @default([])
 *     값 집합: "주중반" | "주말반" | "드라이빙"
 *   - primaryTeam이 있는 사람의 병행 분류만 extraFlags에 넣고,
 *     extra-only는 team에만 두고 extraFlags는 비움 (중복 저장 방지)
 * - 기존 Schedule/Assignment 등은 caddyId + team 문자열에 의존하므로
 *   team 의미를 깨지 않는 선에서만 확장
 */

/** 명시적 확인 대상 — 자동 매칭·신규 생성 금지 (추가 안전장치) */
export const NEEDS_REVIEW_NAMES = [
  "박준형",
  "김기환2",
  "김예진1",
  "김예진2",
] as const;

/**
 * 휴무/병가/찾근/마샬/당번 등은 퇴사가 아님.
 * import 경로에서 employmentStatus(퇴사)로 해석·변경하지 않는다.
 */
export const NON_RESIGNATION_STATUSES = [
  "휴무",
  "병가",
  "장기병가",
  "찾근",
  "마샬",
  "당번",
  "OFF",
  "SICK",
  "LONG_SICK",
  "MARSHAL",
  "DUTY",
] as const;

/** 주중반/주말반/드라이빙 — team이 아니라 별도 분류(extra flag) */
export const EXTRA_FLAG_TEAMS = ["주중반", "주말반", "드라이빙"] as const;
export type ExtraFlag = (typeof EXTRA_FLAG_TEAMS)[number];

/** 주중반/주말반은 향후 THIRD 대상 — 이번 작업에서 DB/타입 반영 금지 */
export const DEFERRED_THIRD_TEAMS = ["주중반", "주말반"] as const;

export function normalizePersonName(name: string): string {
  return name.trim().replace(/\s+/g, "");
}

/**
 * 카트번호·행번호·조내 순번처럼 숫자만 있는 값은 성명이 아니다.
 * 김예진1 같은 끝자리 숫자 실명은 해당하지 않는다.
 */
export function isNumericOnlyRosterName(name: string): boolean {
  return /^\d+$/.test(normalizePersonName(name));
}

/** 분석/리뷰용 — 매칭 키로 쓰지 말 것 (1/2는 서로 다른 사람) */
export function stripTrailingDigits(name: string): string {
  return normalizePersonName(name).replace(/[0-9]+$/u, "");
}

export function hasTrailingDigits(name: string): boolean {
  return /[0-9]+$/u.test(normalizePersonName(name));
}

export function isPrimaryTeam(team: string): boolean {
  return /^([1-9]|1[0-2])조$/.test(team.trim().replace(/\s+/g, ""));
}

export function isExtraFlag(team: string): team is ExtraFlag {
  return (EXTRA_FLAG_TEAMS as readonly string[]).includes(
    team.trim().replace(/\s+/g, "")
  );
}

export function isNeedsReviewName(name: string): boolean {
  const n = normalizePersonName(name);
  return (NEEDS_REVIEW_NAMES as readonly string[]).includes(n);
}

export function isNonResignationStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.trim();
  return (NON_RESIGNATION_STATUSES as readonly string[]).some(
    (x) => x.toLowerCase() === s.toLowerCase()
  );
}

/**
 * v1 호환: 호출부가 "기본값으로 employment를 만지지 않음"을 표시할 때 사용.
 * v2 CSV에 employmentStatus 값이 명시되면 apply가 해당 필드만 갱신한다.
 */
export function shouldTouchEmploymentStatus(_input?: unknown): false {
  return false;
}

export type EmploymentStatusValue = "ACTIVE" | "LEAVE" | "RETIRED";

/** CSV employmentStatus 셀 파싱. 빈칸 → null(유지). 무효 → throw. */
export function parseImportEmploymentStatus(
  raw: string | null | undefined
): EmploymentStatusValue | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const upper = v.toUpperCase();
  if (upper === "ACTIVE" || v === "재직") return "ACTIVE";
  if (upper === "LEAVE" || v === "휴직") return "LEAVE";
  if (upper === "RETIRED" || v === "퇴사") return "RETIRED";
  throw new Error(
    `유효하지 않은 재직상태입니다: ${v} (ACTIVE|LEAVE|RETIRED 또는 재직|휴직|퇴사)`
  );
}

/** teamOrder 셀: 양의 정수(≥1). 빈칸 → null(유지). */
export function parseImportTeamOrder(
  raw: string | null | undefined
): number | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (!/^\d+$/.test(v)) {
    throw new Error(`teamOrder는 양의 정수여야 합니다: ${v}`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`teamOrder는 1 이상의 정수여야 합니다: ${v}`);
  }
  return n;
}

/** Levenshtein distance (짧은 이름용). 자동 매칭에 사용하지 않음. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 1) {
    // Preview 후보 필터: 길이 차이 2 이상은 제외해 노이즈 감소
    return Math.abs(a.length - b.length) + Math.max(a.length, b.length);
  }
  const dp = [...Array(b.length + 1).keys()];
  for (let i = 0; i < a.length; i++) {
    let prev = dp[0];
    dp[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const tmp = dp[j + 1];
      dp[j + 1] = Math.min(
        dp[j + 1] + 1,
        dp[j] + 1,
        prev + (a[i] === b[j] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * 기존 team 필드와 호환되는 소속 문자열.
 * - primaryTeam이 있으면 그것을 사용 (extra는 flags로만)
 * - extra-only면 해당 분류를 team에 저장
 */
export function compatibleTeamFrom(
  primaryTeam: string | null,
  extras: readonly string[]
): string {
  if (primaryTeam) return primaryTeam;
  if (extras.length > 0) return extras[0];
  return "";
}
