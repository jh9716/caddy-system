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
import { isDailyOpsDutyRole } from "@/lib/dailyOpsDuty";
import {
  fetchPublishedOffSheets,
} from "@/lib/offSheetFetch";
import { offNamesForDate, type OffSheet } from "@/lib/offSheetParser";
import { fetchPublishedOpsDutySheets } from "@/lib/opsDutySheetFetch";
import { type OpsDutySheet } from "@/lib/opsDutySheetParser";
import {
  resolveEffectiveOpsDuty,
  type StoredOpsDutyOverrideRow,
} from "@/lib/opsDutyEffectiveService";
import type { NameMatchCaddy } from "@/lib/dailyCaddyNameMatch";

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
  listOverrides?: (ymd: string) => Promise<StoredOpsDutyOverrideRow[]>;
  listCaddies?: () => Promise<Array<NameMatchCaddy & { team?: string }>>;
  fetchOffSheets?: () => Promise<OffSheet[]>;
  fetchOpsDutySheets?: () => Promise<OpsDutySheet[]>;
};

function dutyInputsFromEffective(
  rows: Array<{ role: string; name: string; rawName?: string }>
): AdminOpsDutyNameInput[] {
  const out: AdminOpsDutyNameInput[] = [];
  for (const row of rows) {
    if (!isDailyOpsDutyRole(row.role)) continue;
    out.push({
      role: row.role,
      name: row.name,
      rawName: row.rawName || row.name,
    });
  }
  return out;
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

  const resolvedDuty = await resolveEffectiveOpsDuty(ymd, {
    listDuties,
    fetchOpsDutySheets: fetchOps,
    listOverrides: deps.listOverrides,
    listCaddies: deps.listCaddies,
  });
  const dutySource = resolvedDuty.baseSource;
  const dutyError = resolvedDuty.error;

  const offOk = Boolean(offSheets && offDateFound && !offError);
  const dutyOk = dutySource === "stored" || dutySource === "sheet";
  const completeForSnapshot = offOk && dutyOk;
  const quality: AdminOpsSourceQuality = completeForSnapshot ? "complete" : "fallback";
  let skipReason: string | null = null;
  if (!offOk) skipReason = offError || "off_sheet_incomplete";
  else if (!dutyOk) skipReason = dutyError || "ops_duty_incomplete";

  const availability = await loadAvailability(ymd, {
    includeOffSheet: offOk,
    offSheets: offOk && offSheets ? offSheets : undefined,
    includeStoredOpsDuty: false,
    dutyEntries: resolvedDuty.entries,
  });

  const opsDuties = dutyInputsFromEffective(resolvedDuty.rows);

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
