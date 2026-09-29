/**
 * Legacy /api/assignments validation only.
 * Auth stays on requireAdmin / requirePublishedReader — no new auth system.
 */

export const LEGACY_ASSIGNMENT_TYPES = [
  "OFF",
  "SICK",
  "LONG_SICK",
  "DUTY",
  "MARSHAL",
  "ACCIDENT",
  "FAMILY_EVENT",
] as const;

export type LegacyAssignmentType = (typeof LEGACY_ASSIGNMENT_TYPES)[number];

const TYPE_SET = new Set<string>(LEGACY_ASSIGNMENT_TYPES);

export function isAllowedAssignmentType(
  value: unknown
): value is LegacyAssignmentType {
  return typeof value === "string" && TYPE_SET.has(value);
}

/** Positive integer id from JSON number or decimal digit string. */
export function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/**
 * Accept YYYY-MM-DD (or ISO prefix). Rejects impossible calendar dates.
 * Persist Date matches prior `new Date("YYYY-MM-DD")` UTC midnight.
 */
export function parseAssignmentYmd(
  value: unknown
): { ymd: string; date: Date } | null {
  if (typeof value !== "string") return null;
  const ymd = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const local = new Date(y, m - 1, d);
  if (
    local.getFullYear() !== y ||
    local.getMonth() !== m - 1 ||
    local.getDate() !== d
  ) {
    return null;
  }
  return { ymd, date: new Date(ymd) };
}

export function isValidDateRange(start: Date, end: Date): boolean {
  return end.getTime() >= start.getTime();
}
