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
import { opsDutyRoleFromKind } from "@/lib/dailyOpsDuty";
import type { DutyExcelEntry } from "@/lib/dutyMarshalLeaderParser";
import {
  fetchPublishedOffSheets,
} from "@/lib/offSheetFetch";
import { offNamesForDate, type OffSheet } from "@/lib/offSheetParser";
import { fetchPublishedOpsDutySheets } from "@/lib/opsDutySheetFetch";
import { type OpsDutySheet } from "@/lib/opsDutySheetParser";
import { resolveOpsDutyReadOnly } from "@/lib/opsDutyReadOnlySource";

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

  const [offResult, resolvedDuty] = await Promise.all([
    (async () => {
      try {
        const sheets = await fetchOff();
        const parsed = offNamesForDate(sheets, ymd);
        const offDateFound = parsed.matchedSheetDates.includes(ymd);
        return {
          offSheets: sheets,
          offDateFound,
          offError: offDateFound ? null : "off_sheet_date_not_found",
        };
      } catch (error) {
        return {
          offSheets: null as OffSheet[] | null,
          offDateFound: false,
          offError: error instanceof Error ? error.message : "off_sheet_fetch_failed",
        };
      }
    })(),
    resolveOpsDutyReadOnly(ymd, {
      listDuties,
      fetchOpsDutySheets: fetchOps,
    }),
  ]);
  const offSheets = offResult.offSheets;
  const offDateFound = offResult.offDateFound;
  const offError = offResult.offError;
  const stored = resolvedDuty.stored;
  const dutyEntries = resolvedDuty.sheetEntries;
  const dutySource = resolvedDuty.source;
  const dutyError = resolvedDuty.error;

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
    // Dashboard는 stored/sheet base만. override는 운영현황 slots에서만 본다.
    includeStoredOpsDuty: false,
    dutyEntries:
      dutySource === "stored" || dutySource === "sheet" ? dutyEntries : undefined,
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
