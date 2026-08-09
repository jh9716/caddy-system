/**
 * 캐디 명단 import 규칙 (DB/스키마 변경 없음)
 */

/** 자동 매칭·신규 생성 금지 — 확인 필요 */
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

/** 주중반/주말반은 향후 THIRD 대상 — 이번 작업에서 DB/타입 반영 금지 */
export const DEFERRED_THIRD_TEAMS = ["주중반", "주말반"] as const;

export function normalizePersonName(name: string): string {
  return name.trim().replace(/\s+/g, "");
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

/** import apply에서 employmentStatus를 절대 건드리지 않음 */
export function shouldTouchEmploymentStatus(_input?: unknown): false {
  return false;
}
