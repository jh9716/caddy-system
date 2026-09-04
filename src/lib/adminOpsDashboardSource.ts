/**
 * 관리자 대시보드 / Snapshot 공통 read-only 운영현황 source.
 * OFF·운영배치 Sheet는 fetch/parse만. replace/autosync/Assignment write 없음.
 */

import {
  buildAdminOpsDashboard,
  type AdminOpsDashboardPayload,
  type AdminOpsDutyNameInput,
} from "@/lib/adminOpsDashboard";
import { loadAvailabilityForDate } from "@/lib/availabilityService";
import {
  listDailyOpsDuties,
  type StoredOpsDutyRow,
} from "@/lib/dailyOpsDutyService";
import { dutyEntriesFromStored, opsDutyRoleFromKind } from "@/lib/dailyOpsDuty";
import type { DutyExcelEntry } from "@/lib/dutyMarshalLeaderParser";
import {
  fetchPublishedOffSheets,
} from "@/lib/offSheetFetch";
import { offNamesForDate, type OffSheet } from "@/lib/offSheetParser";
import { fetchPublishedOpsDutySheets } from "@/lib/opsDutySheetFetch";
import {
  parseOpsDutySheetsForDate,
  type OpsDutySheet,
} from "@/lib/opsDutySheetParser";

export type AdminOpsSourceQuality = "complete" | "fallback";
export type AdminOpsOffSource = "sheet" | "assignment_only";
export type AdminOpsDutySource = "stored" | "sheet" | "none";

export type AdminOpsDashboardSourceResult = {
  dashboard: AdminOpsDashboardPayload;
  quality: AdminOpsSourceQuality;
  offSource: AdminOpsOffSource;
  dutySource: AdminOpsDutySource;
  completeForSnapshot: boolean;
  skipReason: string | null;
};

export type AdminOpsDashboardSourceDeps = {
  loadAvailability?: typeof loadAvailabilityForDate;
  listDuties?: (ymd: string) => Promise<StoredOpsDutyRow[]>;
  fetchOffSheets?: () => Promise<OffSheet[]>;
  fetchOpsDutySheets?: () => Promise<OpsDutySheet[]>;
};

function dutyInputsFromEntries(entries: DutyExcelEntry[]): AdminOpsDutyNameInput[] {
  return entries.map((entry) => ({
    role: opsDutyRoleFromKind(entry.kind),
    name: entry.rawName,
    rawName: entry.rawName,
  }));
}

function dutyInputsFromStored(rows: StoredOpsDutyRow[]): AdminOpsDutyNameInput[] {
  return rows.map((row) => ({
    role: row.role,
    name: row.name,
    rawName: row.rawName,
  }));
}

export async function loadAdminOpsDashboardSource(
  ymd: string,
  deps: AdminOpsDashboardSourceDeps = {}
): Promise<AdminOpsDashboardSourceResult> {
  const loadAvailability = deps.loadAvailability ?? loadAvailabilityForDate;
  const listDuties = deps.listDuties ?? listDailyOpsDuties;
  const fetchOff = deps.fetchOffSheets ?? fetchPublishedOffSheets;
  const fetchOps = deps.fetchOpsDutySheets ?? fetchPublishedOpsDutySheets;

  let offSheets: OffSheet[] | null = null;
  let offDateFound = false;
  let offError: string | null = null;
  try {
    offSheets = await fetchOff();
    const parsed = offNamesForDate(offSheets, ymd);
    offDateFound = parsed.matchedSheetDates.includes(ymd);
    if (!offDateFound) offError = "off_sheet_date_not_found";
  } catch (error) {
    offError = error instanceof Error ? error.message : "off_sheet_fetch_failed";
  }

  const stored = await listDuties(ymd);
  let dutyEntries: DutyExcelEntry[] = [];
  let dutySource: AdminOpsDutySource = "none";
  let dutyError: string | null = null;
  if (stored.length > 0) {
    dutySource = "stored";
    dutyEntries = dutyEntriesFromStored(stored);
  } else {
    try {
      const sheets = await fetchOps();
      const parsed = parseOpsDutySheetsForDate(sheets, ymd);
      dutySource = "sheet";
      dutyEntries = parsed.entries;
      if (dutyEntries.length === 0) dutyError = "ops_duty_sheet_empty";
    } catch (error) {
      dutyError = error instanceof Error ? error.message : "ops_duty_sheet_failed";
    }
  }

  const offOk = Boolean(offSheets && offDateFound && !offError);
  const dutyOk =
    dutySource === "stored" || (dutySource === "sheet" && dutyEntries.length > 0);
  const completeForSnapshot = offOk && dutyOk;
  const quality: AdminOpsSourceQuality = completeForSnapshot ? "complete" : "fallback";
  let skipReason: string | null = null;
  if (!offOk) skipReason = offError || "off_sheet_incomplete";
  else if (!dutyOk) skipReason = dutyError || "ops_duty_incomplete";

  const availability = await loadAvailability(ymd, {
    includeOffSheet: offOk,
    offSheets: offOk && offSheets ? offSheets : undefined,
    includeStoredOpsDuty: dutySource === "stored",
    dutyEntries: dutySource === "sheet" ? dutyEntries : undefined,
  });

  const opsDuties =
    dutySource === "stored"
      ? dutyInputsFromStored(stored)
      : dutyInputsFromEntries(dutyEntries);

  return {
    dashboard: buildAdminOpsDashboard({
      date: ymd,
      availability,
      opsDuties,
    }),
    quality,
    offSource: offOk ? "sheet" : "assignment_only",
    dutySource,
    completeForSnapshot,
    skipReason,
  };
}
