/**
 * 관리자 대시보드 V2 로더 (READ ONLY).
 * OFF/운영배치 Sheet fetch는 허용. autosync / DailyOpsDuty write / Draft·Published write 없음.
 */

import { parseYmd } from "@/lib/availabilityEngine";
import { type AdminOpsDashboardPayload } from "@/lib/adminOpsDashboard";
import {
  loadAdminOpsDashboardSource,
  type AdminOpsDashboardSourceDeps,
  type AdminOpsDashboardSourceResult,
} from "@/lib/adminOpsDashboardSource";

export async function loadAdminOpsDashboard(
  ymd: string,
  deps?: AdminOpsDashboardSourceDeps
): Promise<AdminOpsDashboardPayload> {
  const loaded = await loadAdminOpsDashboardWithSource(ymd, deps);
  return loaded.dashboard;
}

export async function loadAdminOpsDashboardWithSource(
  ymd: string,
  deps?: AdminOpsDashboardSourceDeps
): Promise<AdminOpsDashboardSourceResult> {
  parseYmd(ymd);
  return loadAdminOpsDashboardSource(ymd, deps);
}
