/**
 * 관리자 대시보드 V2 Phase 1 로더 (READ ONLY).
 * Google sheet / autosync / DailyOpsDuty write / Draft·Published write 없음.
 */

import { loadAvailabilityForDate } from "@/lib/availabilityService";
import { listDailyOpsDuties } from "@/lib/dailyOpsDutyService";
import { parseYmd } from "@/lib/availabilityEngine";
import {
  buildAdminOpsDashboard,
  type AdminOpsDashboardPayload,
} from "@/lib/adminOpsDashboard";

export const ADMIN_OPS_DASHBOARD_LOAD_OPTIONS = {
  includeOffSheet: false,
  includeStoredOpsDuty: true,
} as const;

export async function loadAdminOpsDashboard(
  ymd: string
): Promise<AdminOpsDashboardPayload> {
  parseYmd(ymd);
  const [availability, opsDuties] = await Promise.all([
    loadAvailabilityForDate(ymd, { ...ADMIN_OPS_DASHBOARD_LOAD_OPTIONS }),
    listDailyOpsDuties(ymd),
  ]);
  return buildAdminOpsDashboard({
    date: ymd,
    availability,
    opsDuties,
  });
}
