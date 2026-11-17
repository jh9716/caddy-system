/**
 * Assignment-eligible roster vs operational roster.
 *
 * operationalRoster.ts keeps LEAVE for 캐디관리, slot occupancy, and
 * current-ops panels. This module is the assignable gate used by
 * auto-assign, reflow, unused/manual pickers, spare, and special-duty
 * candidate lists. RETIRED/DELETED stay out of both.
 *
 * Employment merge: mixed untrusted sources prefer inactive (LEAVE/
 * RETIRED) over stale ACTIVE. Optional authority (latest DB Caddy rows)
 * last-wins so a real return to ACTIVE can be assigned again.
 */

import {
  isInactiveEmploymentAvailability,
  type AvailabilityResult,
} from "@/lib/availabilityEngine";

export const INACTIVE_EMPLOYMENT_WARNING_CODE = "INACTIVE_EMPLOYMENT";
export const PUBLISH_INACTIVE_EMPLOYMENT_CODE = "INACTIVE_EMPLOYMENT";
export const PUBLISH_EMPLOYMENT_LOOKUP_UNAVAILABLE_CODE =
  "EMPLOYMENT_LOOKUP_UNAVAILABLE";
export const PUBLISH_UNKNOWN_CADDY_CODE = "UNKNOWN_CADDY";

export const PUBLISH_EMPLOYMENT_LOOKUP_UNAVAILABLE_MESSAGE =
  "캐디 재직 상태를 확인할 수 없어 공개할 수 없습니다.";

export type AssignableEmploymentRow = {
  id?: number;
  caddyId?: number;
  name?: string | null;
  employmentStatus?: unknown;
  excludedReasons?: readonly string[] | null;
};

export type EmploymentMergePolicy = "prefer-inactive" | "authority";

export type PlacedCaddyRef = {
  id: number;
  name: string;
};

export function unknownPlacedCaddyMessage(
  missing: readonly PlacedCaddyRef[]
): string {
  const who = missing
    .map((person) => `${person.name}(#${person.id})`)
    .join(", ");
  return `존재하지 않는 캐디가 배치되어 있어 공개할 수 없습니다: ${who}`;
}

export type InactiveEmploymentIssue = {
  caddyId: number;
  name: string;
  status: string;
  message: string;
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

export function blockedByInactiveEmploymentMessage(
  issues: readonly InactiveEmploymentIssue[]
): string {
  const who = issues
    .map((issue) => {
      const label = inactiveEmploymentLabel(issue.status) || "재직상태 아님";
      return `${issue.name}(${label})`;
    })
    .join(", ");
  return `휴직/퇴사 캐디가 배치되어 있어 공개할 수 없습니다: ${who}`;
}

function positiveCaddyId(row: AssignableEmploymentRow): number | null {
  const id = Number(row.id ?? row.caddyId);
  if (!Number.isInteger(id) || id < 1) return null;
  return id;
}

function mergeEmploymentStatus(
  current: string | undefined,
  incoming: string,
  policy: EmploymentMergePolicy
): string {
  if (current === undefined || policy === "authority") return incoming;
  const currentInactive = !isAssignableEmploymentStatus(current);
  const incomingInactive = !isAssignableEmploymentStatus(incoming);
  if (incomingInactive) return incoming;
  if (currentInactive) return current;
  return incoming;
}

export function employmentStatusById(
  rows: readonly AssignableEmploymentRow[] | null | undefined,
  policy: EmploymentMergePolicy = "prefer-inactive"
): Map<number, string> {
  const byId = new Map<number, string>();
  for (const row of rows || []) {
    const id = positiveCaddyId(row);
    if (id == null) continue;
    if (row.employmentStatus == null) continue;
    const value = String(row.employmentStatus).trim();
    if (!value) continue;
    byId.set(
      id,
      mergeEmploymentStatus(byId.get(id), String(row.employmentStatus), policy)
    );
  }
  return byId;
}

export function overlayLatestEmploymentStatus<
  T extends { id: number; employmentStatus?: string | null },
>(
  rows: readonly T[] | null | undefined,
  source: readonly AssignableEmploymentRow[] | null | undefined,
  authority?: readonly AssignableEmploymentRow[] | null
): T[] {
  const latest = employmentStatusById(source, "prefer-inactive");
  const authoritative = employmentStatusById(authority, "authority");
  return (rows || []).map((row) => {
    const emp =
      authoritative.get(row.id) !== undefined
        ? authoritative.get(row.id)
        : latest.get(row.id);
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

export function collectPlacedCaddyRefs(input: {
  assignments?:
    | readonly {
        caddy?: { id?: number; name?: string | null } | null;
      }[]
    | null;
  sparesByShift?:
    | readonly {
        spare1?: { caddyId?: number; name?: string | null } | null;
        spare2?: { caddyId?: number; name?: string | null } | null;
      }[]
    | null;
}): PlacedCaddyRef[] {
  const refs: PlacedCaddyRef[] = [];
  const seen = new Set<number>();
  const push = (idRaw: unknown, nameRaw: unknown) => {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) return;
    seen.add(id);
    refs.push({
      id,
      name: String(nameRaw || "").trim() || `CADDY#${id}`,
    });
  };
  for (const row of input.assignments || []) {
    push(row.caddy?.id, row.caddy?.name);
  }
  for (const spare of input.sparesByShift || []) {
    push(spare.spare1?.caddyId, spare.spare1?.name);
    push(spare.spare2?.caddyId, spare.spare2?.name);
  }
  return refs;
}

export function inactiveEmploymentIssuesFromDb(
  placed: readonly PlacedCaddyRef[],
  dbRows:
    | readonly AssignableEmploymentRow[]
    | null
    | undefined
): InactiveEmploymentIssue[] {
  const byId = employmentStatusById(dbRows, "authority");
  const nameById = new Map<number, string>();
  for (const row of dbRows || []) {
    const id = positiveCaddyId(row);
    if (id == null) continue;
    const name = String(row.name || "").trim();
    if (name) nameById.set(id, name);
  }
  const found: Array<{ caddyId: number; name: string; status: string }> = [];
  for (const person of placed) {
    const status = byId.get(person.id);
    if (status === undefined) continue;
    if (isAssignableEmploymentStatus(status)) continue;
    found.push({
      caddyId: person.id,
      name: nameById.get(person.id) || person.name,
      status,
    });
  }
  if (found.length === 0) return [];
  const summary = blockedByInactiveEmploymentMessage(
    found.map((row) => ({ ...row, message: "" }))
  );
  return found.map((row) => ({ ...row, message: summary }));
}

export function missingPlacedCaddyRefs(
  placed: readonly PlacedCaddyRef[],
  dbRows: readonly AssignableEmploymentRow[] | null | undefined
): PlacedCaddyRef[] {
  const found = new Set<number>();
  for (const row of dbRows || []) {
    const id = positiveCaddyId(row);
    if (id == null) continue;
    found.add(id);
  }
  return placed.filter((person) => !found.has(person.id));
}
