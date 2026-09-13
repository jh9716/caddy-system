/**
 * Current operational roster filter for /manage/assignments.
 * ACTIVE remains. RETIRED / DELETED / 퇴사 / 삭제 are absent from current ops.
 * Does not hard-delete rows or rewrite Published / Snapshot history.
 */

const NON_OPERATIONAL_STATUS = new Set([
  "RETIRED",
  "DELETED",
  "퇴사",
  "삭제",
  "삭제됨",
]);

export type OperationalRosterRow = {
  id?: number;
  caddyId?: number;
  employmentStatus?: unknown;
  excludedReasons?: readonly string[] | null;
};

export function isOperationalEmploymentStatus(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  if (NON_OPERATIONAL_STATUS.has(raw)) return false;
  const upper = raw.toUpperCase();
  if (NON_OPERATIONAL_STATUS.has(upper)) return false;
  if (upper === "RETIRED" || upper === "DELETED") return false;
  if (/퇴사\(RETIRED\)/.test(raw) || /삭제됨/.test(raw)) return false;
  return true;
}

export function isOperationalCaddy(
  row: OperationalRosterRow | null | undefined
): boolean {
  if (!row) return false;
  if (!isOperationalEmploymentStatus(row.employmentStatus)) return false;
  const emp = String(row.employmentStatus ?? "").trim().toUpperCase();
  if (emp === "ACTIVE" || emp === "재직") return true;
  const reasons = (row.excludedReasons || []).join(" ");
  if (/퇴사\(RETIRED\)/.test(reasons) || /\bRETIRED\b/.test(reasons)) {
    return false;
  }
  if (/삭제됨|\bDELETED\b/.test(reasons)) return false;
  return true;
}

export function filterOperationalRoster<T extends OperationalRosterRow>(
  rows: readonly T[] | null | undefined
): T[] {
  return (rows || []).filter((row) => isOperationalCaddy(row));
}

export function operationalCaddyIds(
  rows: readonly OperationalRosterRow[] | null | undefined
): Set<number> {
  const ids = new Set<number>();
  for (const row of rows || []) {
    if (!isOperationalCaddy(row)) continue;
    const id = Number(row.id ?? row.caddyId);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

export function mergeOperationalRoster<
  T extends {
    id: number;
    name?: string;
    team?: string;
    employmentStatus?: unknown;
    excludedReasons?: readonly string[] | null;
  },
>(
  ...groups: Array<readonly T[] | null | undefined>
): Array<{
  id: number;
  name: string;
  team: string;
  employmentStatus?: string;
  excludedReasons?: string[];
}> {
  const byId = new Map<
    number,
    {
      id: number;
      name: string;
      team: string;
      employmentStatus?: string;
      excludedReasons?: string[];
    }
  >();
  for (const group of groups) {
    for (const row of group || []) {
      const id = Number(row.id);
      if (!Number.isInteger(id) || id < 1 || byId.has(id)) continue;
      byId.set(id, {
        id,
        name: String(row.name || "").trim(),
        team: String(row.team || "").trim(),
        employmentStatus:
          row.employmentStatus == null
            ? undefined
            : String(row.employmentStatus),
        excludedReasons: row.excludedReasons
          ? [...row.excludedReasons].map((r) => String(r))
          : undefined,
      });
    }
  }
  return filterOperationalRoster([...byId.values()]);
}
