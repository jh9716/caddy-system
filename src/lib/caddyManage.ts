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

export const EXTRA_FLAG_OPTIONS = ["주중반", "주말반", "드라이빙"] as const;
export type ExtraFlagOption = (typeof EXTRA_FLAG_OPTIONS)[number];

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
