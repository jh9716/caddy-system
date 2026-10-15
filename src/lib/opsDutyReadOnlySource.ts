/**
 * DailyOpsDuty 없으면 운영배치 Sheet를 read-only로 읽는다.
 * dashboard/snapshot과 같은 fallback. replace/autosync/write 없음.
 *
 * 마샬은 key별: FINALIZED MarshalMonthSlot > stored marshal > Sheet marshal.
 * 당번/조장 precedence는 기존과 같다: stored(date-level) > sheet.
 */

import {
  matchDutyEntriesToCaddies,
  type DailyOpsDutyRole,
} from "@/lib/dailyOpsDuty";
import { filterOperationalRoster, isOperationalCaddy } from "@/lib/operationalRoster";
import {
  listDailyOpsDuties,
  type StoredOpsDutyRow,
} from "@/lib/dailyOpsDutyService";
import type { DutyExcelEntry } from "@/lib/dutyMarshalLeaderParser";
import type { NameMatchCaddy } from "@/lib/dailyCaddyNameMatch";
import { fetchPublishedOpsDutySheets } from "@/lib/opsDutySheetFetch";
import {
  parseOpsDutySheetsForDate,
  type OpsDutySheet,
} from "@/lib/opsDutySheetParser";
import {
  isContractMarshalRoleKey,
  isMarshalDutyEligibleCaddy,
  isMarshalMonthDutyRoleKey,
  listFinalizedMarshalMonthDutyRows,
  mergeLegacyDutyEntries,
  missingContractMarshalKeys,
  overlayMonthlyMarshalDutyEntries,
  resolveMarshalDutySource,
  type MonthlyMarshalDutyRow,
  type OpsDutyMarshalSource,
} from "@/lib/marshalMonthDutySource";

export type OpsDutyReadOnlySource = "stored" | "sheet" | "none";

export type OpsDutyPanelRow = {
  caddyId: number;
  name: string;
  team: string;
  role: DailyOpsDutyRole | string;
  roleKey: string;
  rawName?: string;
};

export type ResolveOpsDutyReadOnlyResult = {
  source: OpsDutyReadOnlySource;
  marshalSource?: OpsDutyMarshalSource;
  stored: StoredOpsDutyRow[];
  sheetEntries: DutyExcelEntry[];
  monthlyMarshal?: MonthlyMarshalDutyRow[];
  error: string | null;
};

export type ResolveOpsDutyReadOnlyDeps = {
  listDuties?: (ymd: string) => Promise<StoredOpsDutyRow[]>;
  fetchOpsDutySheets?: () => Promise<OpsDutySheet[]>;
  listMonthlyMarshal?: (ymd: string) => Promise<MonthlyMarshalDutyRow[]>;
};

function withMarshalMeta(
  result: Omit<ResolveOpsDutyReadOnlyResult, "marshalSource" | "monthlyMarshal">,
  monthlyMarshal: MonthlyMarshalDutyRow[]
): ResolveOpsDutyReadOnlyResult {
  return {
    ...result,
    monthlyMarshal,
    marshalSource: resolveMarshalDutySource({
      monthlyRows: monthlyMarshal,
      storedRoleKeys: result.stored.map((row) => row.roleKey),
      sheetMarshalRoleKeys: result.sheetEntries
        .filter((entry) => isContractMarshalRoleKey(entry.roleKey))
        .map((entry) => entry.roleKey),
    }),
  };
}

async function loadMonthlyMarshalRows(
  ymd: string,
  deps: ResolveOpsDutyReadOnlyDeps
): Promise<MonthlyMarshalDutyRow[]> {
  const loader =
    deps.listMonthlyMarshal ?? ((date: string) => listFinalizedMarshalMonthDutyRows(date));
  const rows = await loader(ymd);
  if (!Array.isArray(rows)) {
    throw new Error("monthly marshal loader returned non-array");
  }
  return rows;
}

async function loadSheetEntries(
  fetchOps: () => Promise<OpsDutySheet[]>,
  ymd: string
): Promise<{ entries: DutyExcelEntry[]; error: string | null }> {
  const sheets = await fetchOps();
  const parsed = parseOpsDutySheetsForDate(sheets, ymd);
  return {
    entries: parsed.entries,
    error: parsed.entries.length > 0 ? null : "ops_duty_sheet_empty",
  };
}

export async function resolveOpsDutyReadOnly(
  ymd: string,
  deps: ResolveOpsDutyReadOnlyDeps = {}
): Promise<ResolveOpsDutyReadOnlyResult> {
  const listDuties = deps.listDuties ?? listDailyOpsDuties;
  const fetchOps = deps.fetchOpsDutySheets ?? fetchPublishedOpsDutySheets;
  const monthlyP = loadMonthlyMarshalRows(ymd, deps);
  const stored = await listDuties(ymd);
  const monthlyMarshal = await monthlyP;
  const missingMarshal = missingContractMarshalKeys({
    storedRoleKeys: stored.map((row) => row.roleKey),
    monthlyRoleKeys: monthlyMarshal.map((row) => row.roleKey),
  });
  const needSheet = stored.length === 0 || missingMarshal.length > 0;

  if (!needSheet) {
    return withMarshalMeta(
      {
        source: stored.length > 0 ? "stored" : "none",
        stored,
        sheetEntries: [],
        error: null,
      },
      monthlyMarshal
    );
  }

  try {
    const loaded = await loadSheetEntries(fetchOps, ymd);
    if (stored.length > 0) {
      return withMarshalMeta(
        {
          source: "stored",
          stored,
          sheetEntries: loaded.entries,
          // Successful Sheet read: missing marshal keys are normal `none`.
          error: null,
        },
        monthlyMarshal
      );
    }
    return withMarshalMeta(
      {
        source: loaded.entries.length > 0 ? "sheet" : "none",
        stored: [],
        sheetEntries: loaded.entries,
        error: loaded.error,
      },
      monthlyMarshal
    );
  } catch (error) {
    if (stored.length > 0) {
      return withMarshalMeta(
        {
          source: "stored",
          stored,
          sheetEntries: [],
          error:
            error instanceof Error ? error.message : "ops_duty_sheet_failed",
        },
        monthlyMarshal
      );
    }
    return withMarshalMeta(
      {
        source: "none",
        stored: [],
        sheetEntries: [],
        error: error instanceof Error ? error.message : "ops_duty_sheet_failed",
      },
      monthlyMarshal
    );
  }
}

/** Snapshot/dashboard completeness. stored + required Sheet fallback failure is incomplete. */
export function opsDutyReadCompleteForSnapshot(
  resolved: ResolveOpsDutyReadOnlyResult
): boolean {
  if (resolved.error) return false;
  if (resolved.source === "stored") return true;
  return resolved.source === "sheet" && resolved.sheetEntries.length > 0;
}

export function mergedDutyExcelEntriesFromReadOnly(
  resolved: ResolveOpsDutyReadOnlyResult
): DutyExcelEntry[] {
  const legacy = mergeLegacyDutyEntries({
    stored: resolved.stored,
    sheetEntries: resolved.sheetEntries,
  });
  return overlayMonthlyMarshalDutyEntries(legacy, resolved.monthlyMarshal ?? []);
}

function panelRowFromStored(row: StoredOpsDutyRow): OpsDutyPanelRow {
  return {
    caddyId: row.caddyId,
    name: row.name,
    team: row.team,
    role: row.role,
    roleKey: row.roleKey,
    rawName: row.rawName,
  };
}

export function opsDutyPanelRowsFromReadOnly(
  resolved: ResolveOpsDutyReadOnlyResult,
  caddies: readonly (NameMatchCaddy & { team?: string; employmentStatus?: string })[]
): OpsDutyPanelRow[] {
  const operational = filterOperationalRoster(caddies);
  const operationalById = new Map(operational.map((row) => [Number(row.id), row]));
  const monthly = resolved.monthlyMarshal ?? [];
  const monthlyKeys = new Set(monthly.map((row) => row.roleKey));
  const storedByKey = new Map(resolved.stored.map((row) => [row.roleKey, row]));

  const dutyLeaderRows: OpsDutyPanelRow[] = [];
  if (resolved.stored.length > 0) {
    for (const row of resolved.stored) {
      if (isMarshalMonthDutyRoleKey(row.roleKey)) continue;
      const current = operationalById.get(Number(row.caddyId));
      if (!isOperationalCaddy(current || row)) continue;
      dutyLeaderRows.push(panelRowFromStored(row));
    }
  } else if (resolved.sheetEntries.length > 0) {
    const dutyLeaderEntries = resolved.sheetEntries.filter(
      (entry) => !isMarshalMonthDutyRoleKey(entry.roleKey)
    );
    const { matched } = matchDutyEntriesToCaddies(dutyLeaderEntries, operational);
    const teamById = new Map(
      operational.map((row) => [Number(row.id), String(row.team || "").trim() || "—"])
    );
    for (const row of matched) {
      dutyLeaderRows.push({
        caddyId: row.caddyId,
        name: row.name,
        team: teamById.get(row.caddyId) || "—",
        role: row.role,
        roleKey: row.roleKey,
        rawName: row.rawName,
      });
    }
  }

  const marshalLegacyRows: OpsDutyPanelRow[] = [];
  const sheetMarshalEntries = resolved.sheetEntries.filter((entry) =>
    isContractMarshalRoleKey(entry.roleKey)
  );
  const unmatchedSheetMarshal = sheetMarshalEntries.filter(
    (entry) => !monthlyKeys.has(entry.roleKey) && !storedByKey.has(entry.roleKey)
  );
  const { matched: sheetMarshalMatched } = matchDutyEntriesToCaddies(
    unmatchedSheetMarshal,
    operational
  );
  const teamById = new Map(
    operational.map((row) => [Number(row.id), String(row.team || "").trim() || "—"])
  );

  for (const row of resolved.stored) {
    if (!isContractMarshalRoleKey(row.roleKey)) continue;
    if (monthlyKeys.has(row.roleKey)) continue;
    const current = operationalById.get(Number(row.caddyId));
    if (!isOperationalCaddy(current || row)) continue;
    marshalLegacyRows.push(panelRowFromStored(row));
  }
  for (const row of sheetMarshalMatched) {
    marshalLegacyRows.push({
      caddyId: row.caddyId,
      name: row.name,
      team: teamById.get(row.caddyId) || "—",
      role: row.role,
      roleKey: row.roleKey,
      rawName: row.rawName,
    });
  }

  const monthlyRows: OpsDutyPanelRow[] = [];
  const currentById = new Map(caddies.map((row) => [Number(row.id), row]));
  for (const row of monthly) {
    const current = currentById.get(Number(row.caddyId));
    const statusRow = current
      ? { ...row, employmentStatus: current.employmentStatus ?? row.employmentStatus }
      : row;
    if (!isMarshalDutyEligibleCaddy(statusRow)) continue;
    monthlyRows.push({
      caddyId: row.caddyId,
      name: current?.name || row.name,
      team: String(current?.team || row.team || "").trim() || "—",
      role: row.role,
      roleKey: row.roleKey,
      rawName: row.rawName || row.name,
    });
  }

  return [...dutyLeaderRows, ...marshalLegacyRows, ...monthlyRows];
}
