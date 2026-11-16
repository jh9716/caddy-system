/**
 * Assignment-eligible roster vs operational roster.
 *
 * operationalRoster.ts keeps LEAVE for 캐디관리, slot occupancy, and
 * current-ops panels. This module is the assignable gate used by
 * auto-assign, reflow, unused/manual pickers, spare, and special-duty
 * candidate lists. RETIRED/DELETED stay out of both.
 */

import {
  isInactiveEmploymentAvailability,
  type AvailabilityResult,
} from "@/lib/availabilityEngine";

export const INACTIVE_EMPLOYMENT_WARNING_CODE = "INACTIVE_EMPLOYMENT";

export type AssignableEmploymentRow = {
  id?: number;
  caddyId?: number;
  employmentStatus?: unknown;
  excludedReasons?: readonly string[] | null;
};

export function isAssignableEmploymentStatus(value: unknown): boolean {
  return !isInactiveEmploymentAvailability({
    employmentStatus: value == null ? undefined : String(value),
  });
}

export function isAssignableCaddy(
  row: AssignableEmploymentRow | null | undefined
): boolean {
  if (!row) return false;
  return !isInactiveEmploymentAvailability({
    employmentStatus:
      row.employmentStatus == null ? undefined : String(row.employmentStatus),
    excludedReasons: row.excludedReasons,
  });
}

export function filterAssignableCaddies<T extends AssignableEmploymentRow>(
  rows: readonly T[] | null | undefined
): T[] {
  return (rows || []).filter((row) => isAssignableCaddy(row));
}

export function inactiveEmploymentLabel(status: unknown): string | null {
  const raw = String(status ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === "LEAVE" || raw === "휴직") return "휴직";
  if (upper === "RETIRED" || raw === "퇴사") return "퇴사";
  if (
    upper === "DELETED" ||
    raw === "삭제" ||
    raw === "삭제됨" ||
    /삭제됨/.test(raw)
  ) {
    return "삭제";
  }
  if (!isAssignableEmploymentStatus(raw)) return "재직상태 아님";
  return null;
}

export function inactiveEmploymentWarningMessage(
  name: string,
  status: unknown
): string {
  const label = inactiveEmploymentLabel(status) || "재직상태 아님";
  const who = String(name || "").trim() || "캐디";
  return `${who}은(는) ${label} 상태입니다. 신규 자동배치·수동배치·스페어·특수근무 후보에서 제외됩니다. 기존 배치는 유지되니 관리자가 확인하세요.`;
}

export function employmentStatusById(
  rows:
    | readonly AssignableEmploymentRow[]
    | null
    | undefined
): Map<number, string> {
  const byId = new Map<number, string>();
  for (const row of rows || []) {
    const id = Number(row.id ?? row.caddyId);
    if (!Number.isInteger(id) || id < 1) continue;
    if (row.employmentStatus == null) continue;
    const value = String(row.employmentStatus).trim();
    if (!value) continue;
    byId.set(id, String(row.employmentStatus));
  }
  return byId;
}

export function overlayLatestEmploymentStatus<
  T extends { id: number; employmentStatus?: string | null },
>(
  rows: readonly T[] | null | undefined,
  source: readonly AssignableEmploymentRow[] | null | undefined
): T[] {
  const latest = employmentStatusById(source);
  return (rows || []).map((row) => {
    const emp = latest.get(row.id);
    if (emp === undefined) return { ...row };
    return { ...row, employmentStatus: emp };
  });
}

export function employmentRowsFromAvailability(
  availability:
    | Pick<AvailabilityResult, "available" | "special" | "excluded">
    | null
    | undefined
): AssignableEmploymentRow[] {
  if (!availability) return [];
  return [
    ...(availability.available?.all || []),
    ...(availability.special || []),
    ...(availability.excluded || []),
  ];
}
