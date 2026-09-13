/**
 * DailyOpsDuty 없으면 운영배치 Sheet를 read-only로 읽는다.
 * dashboard/snapshot과 같은 fallback. replace/autosync/write 없음.
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
  stored: StoredOpsDutyRow[];
  sheetEntries: DutyExcelEntry[];
  error: string | null;
};

export type ResolveOpsDutyReadOnlyDeps = {
  listDuties?: (ymd: string) => Promise<StoredOpsDutyRow[]>;
  fetchOpsDutySheets?: () => Promise<OpsDutySheet[]>;
};

export async function resolveOpsDutyReadOnly(
  ymd: string,
  deps: ResolveOpsDutyReadOnlyDeps = {}
): Promise<ResolveOpsDutyReadOnlyResult> {
  const listDuties = deps.listDuties ?? listDailyOpsDuties;
  const fetchOps = deps.fetchOpsDutySheets ?? fetchPublishedOpsDutySheets;
  const stored = await listDuties(ymd);
  if (stored.length > 0) {
    return {
      source: "stored",
      stored,
      sheetEntries: dutyEntriesFromStored(stored),
      error: null,
    };
  }
  try {
    const sheets = await fetchOps();
    const parsed = parseOpsDutySheetsForDate(sheets, ymd);
    return {
      source: parsed.entries.length > 0 ? "sheet" : "none",
      stored: [],
      sheetEntries: parsed.entries,
      error: parsed.entries.length > 0 ? null : "ops_duty_sheet_empty",
    };
  } catch (error) {
    return {
      source: "none",
      stored: [],
      sheetEntries: [],
      error: error instanceof Error ? error.message : "ops_duty_sheet_failed",
    };
  }
}

export function opsDutyPanelRowsFromReadOnly(
  resolved: ResolveOpsDutyReadOnlyResult,
  caddies: readonly (NameMatchCaddy & { team?: string })[]
): OpsDutyPanelRow[] {
  const operational = filterOperationalRoster(caddies);
  const operationalById = new Map(operational.map((row) => [Number(row.id), row]));
  if (resolved.source === "stored") {
    return resolved.stored
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
  }
  if (resolved.sheetEntries.length === 0) return [];
  const { matched } = matchDutyEntriesToCaddies(resolved.sheetEntries, operational);
  const teamById = new Map(
    operational.map((row) => [Number(row.id), String(row.team || "").trim() || "—"])
  );
  return matched.map((row) => ({
    caddyId: row.caddyId,
    name: row.name,
    team: teamById.get(row.caddyId) || "—",
    role: row.role,
    roleKey: row.roleKey,
    rawName: row.rawName,
  }));
}
