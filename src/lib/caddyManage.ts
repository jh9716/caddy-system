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

export const EMPLOYMENT_STATUSES = ["재직", "퇴사"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

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

export function normalizeEmploymentStatus(input: unknown): EmploymentStatus {
  const v = String(input ?? "").trim();
  if (v === "퇴사" || v === "RETIRED" || v === "retired") return "퇴사";
  return "재직";
}

export function normalizeTeamOrder(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}
