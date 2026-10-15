/**
 * DailyOpsDuty 없으면 운영배치 Sheet를 read-only로 읽는다.
 * dashboard/snapshot과 같은 fallback. replace/autosync/write 없음.
 *
 * 마샬 roleKey만 FINALIZED MarshalMonthSlot 을 stored/sheet 위에 overlay 한다.
 * 당번/조장 precedence는 기존과 같다: stored > sheet.
 */

import {
  dutyEntriesFromStored,
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
  listFinalizedMarshalMonthDutyRows,
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
  const legacyEntries =
    result.source === "stored"
      ? dutyEntriesFromStored(result.stored)
      : result.sheetEntries;
  return {
    ...result,
    monthlyMarshal,
    marshalSource: resolveMarshalDutySource({
      monthlyRows: monthlyMarshal,
      legacySource: result.source,
      legacyEntries,
    }),
  };
}

async function loadMonthlyMarshalRows(
  ymd: string,
  deps: ResolveOpsDutyReadOnlyDeps
): Promise<MonthlyMarshalDutyRow[]> {
  const loader =
    deps.listMonthlyMarshal ?? ((date: string) => listFinalizedMarshalMonthDutyRows(date));
  try {
    const rows = await loader(ymd);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error("[opsDutyReadOnlySource] monthly marshal skipped", error);
    return [];
  }
}

export async function resolveOpsDutyReadOnly(
  ymd: string,
  deps: ResolveOpsDutyReadOnlyDeps = {}
): Promise<ResolveOpsDutyReadOnlyResult> {
  const listDuties = deps.listDuties ?? listDailyOpsDuties;
  const fetchOps = deps.fetchOpsDutySheets ?? fetchPublishedOpsDutySheets;
  const monthlyP = loadMonthlyMarshalRows(ymd, deps);
  const stored = await listDuties(ymd);
  if (stored.length > 0) {
    const monthlyMarshal = await monthlyP;
    return withMarshalMeta(
      {
        source: "stored",
        stored,
        sheetEntries: dutyEntriesFromStored(stored),
        error: null,
      },
      monthlyMarshal
    );
  }
  try {
    const sheets = await fetchOps();
    const parsed = parseOpsDutySheetsForDate(sheets, ymd);
    const monthlyMarshal = await monthlyP;
    return withMarshalMeta(
      {
        source: parsed.entries.length > 0 ? "sheet" : "none",
        stored: [],
        sheetEntries: parsed.entries,
        error: parsed.entries.length > 0 ? null : "ops_duty_sheet_empty",
      },
      monthlyMarshal
    );
  } catch (error) {
    const monthlyMarshal = await monthlyP;
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

export function mergedDutyExcelEntriesFromReadOnly(
  resolved: ResolveOpsDutyReadOnlyResult
): DutyExcelEntry[] {
  const legacy =
    resolved.source === "stored"
      ? dutyEntriesFromStored(resolved.stored)
      : resolved.sheetEntries;
  return overlayMonthlyMarshalDutyEntries(
    legacy,
    resolved.monthlyMarshal ?? []
  );
}

export function opsDutyPanelRowsFromReadOnly(
  resolved: ResolveOpsDutyReadOnlyResult,
  caddies: readonly (NameMatchCaddy & { team?: string; employmentStatus?: string })[]
): OpsDutyPanelRow[] {
  const operational = filterOperationalRoster(caddies);
  const operationalById = new Map(operational.map((row) => [Number(row.id), row]));
  let baseRows: OpsDutyPanelRow[] = [];
  if (resolved.source === "stored") {
    baseRows = resolved.stored
      .filter((row) => {
        const current = operationalById.get(Number(row.caddyId));
        return isOperationalCaddy(current || row);
      })
      .map((row) => ({
        caddyId: row.caddyId,
        name: row.name,
        team: row.team,
        role: row.role,
        roleKey: row.roleKey,
        rawName: row.rawName,
      }));
  } else if (resolved.sheetEntries.length > 0) {
    const { matched } = matchDutyEntriesToCaddies(resolved.sheetEntries, operational);
    const teamById = new Map(
      operational.map((row) => [Number(row.id), String(row.team || "").trim() || "—"])
    );
    baseRows = matched.map((row) => ({
      caddyId: row.caddyId,
      name: row.name,
      team: teamById.get(row.caddyId) || "—",
      role: row.role,
      roleKey: row.roleKey,
      rawName: row.rawName,
    }));
  }

  const monthly = resolved.monthlyMarshal ?? [];
  if (monthly.length === 0) return baseRows;

  const monthlyKeys = new Set<string>();
  const monthlyRows: OpsDutyPanelRow[] = [];
  for (const row of monthly) {
    const current = operationalById.get(Number(row.caddyId));
    if (!isOperationalCaddy(current || row)) continue;
    monthlyKeys.add(row.roleKey);
    monthlyRows.push({
      caddyId: row.caddyId,
      name: current?.name || row.name,
      team: String(current?.team || row.team || "").trim() || "—",
      role: row.role,
      roleKey: row.roleKey,
      rawName: row.rawName || row.name,
    });
  }
  if (monthlyRows.length === 0) return baseRows;
  return [...baseRows.filter((row) => !monthlyKeys.has(row.roleKey)), ...monthlyRows];
}
