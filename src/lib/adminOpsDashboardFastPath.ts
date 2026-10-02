/**
 * /manage dashboard DB-first / last-success fast path.
 * Sheet HTTP는 peek만. fetchPublishedOffSheets는 refresh 경로에서만.
 * availabilityService 기본(blocking Sheet) 의미는 바꾸지 않는다.
 */

import {
  CADDY_TYPE_DASH_LABEL,
  DASHBOARD_PENDING_STATUS_LABEL,
  countActiveRoster,
  groupOpsDutyNames,
  type AdminOpsCaddyRow,
} from "@/lib/adminOpsDashboard";
import { normalizeEmploymentStatus } from "@/lib/caddyManage";
import type { CaddyTypeCode } from "@/lib/availabilityEngine";
import { parseYmd } from "@/lib/availabilityEngine";
import {
  attachDashboardFreshness,
  lastSuccessViewForDate,
  peekAdminOpsDashboardLastSuccess,
  rememberAdminOpsDashboardSuccess,
  shouldKeepPreviousDashboardSuccess,
  type AdminOpsDashboardFreshView,
} from "@/lib/adminOpsDashboardFreshness";
import type { AdminOpsDashboardSourceDeps } from "@/lib/adminOpsDashboardSource";
import { loadAdminOpsDashboardWithSource } from "@/lib/adminOpsDashboardService";
import { dashboardViewFromLive } from "@/lib/dailyOpsSnapshot";
import { listDailyOpsDuties } from "@/lib/dailyOpsDutyService";
import { peekCachedOffSheetsForDate } from "@/lib/offSheetFetch";
import { peekCachedOpsDutySheets } from "@/lib/opsDutySheetFetch";
import { prisma } from "@/lib/prisma";

export type DashboardRosterRow = {
  id: number;
  name: string;
  team: string;
  employmentStatus: string;
  caddyType: string;
};

export type AdminOpsDashboardFastPathDeps = AdminOpsDashboardSourceDeps & {
  listRoster?: () => Promise<DashboardRosterRow[]>;
  nowMs?: number;
  isPastDate?: boolean;
};

function asCaddyType(value: unknown): CaddyTypeCode {
  if (value === "THIRD" || value === "DRIVING" || value === "HOUSE") return value;
  return "HOUSE";
}

export function pendingAdminOpsCaddyRow(row: DashboardRosterRow): AdminOpsCaddyRow {
  const caddyType = asCaddyType(row.caddyType);
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    caddyType,
    caddyTypeLabel: CADDY_TYPE_DASH_LABEL[caddyType],
    bucket: "available",
    status: "available",
    statusLabel: DASHBOARD_PENDING_STATUS_LABEL,
    statusTone: "other",
    reasons: [DASHBOARD_PENDING_STATUS_LABEL],
  };
}

export async function loadAdminOpsDashboardDbFirst(
  ymd: string,
  deps: AdminOpsDashboardFastPathDeps = {}
): Promise<AdminOpsDashboardFreshView> {
  parseYmd(ymd);
  const listDuties = deps.listDuties ?? listDailyOpsDuties;
  const roster =
    deps.listRoster ??
    (async () =>
      prisma.caddy.findMany({
        select: {
          id: true,
          name: true,
          team: true,
          employmentStatus: true,
          caddyType: true,
        },
        orderBy: [{ team: "asc" }, { id: "asc" }],
      }));
  const [caddies, stored] = await Promise.all([roster(), listDuties(ymd)]);
  const visible = caddies.filter(
    (row) => normalizeEmploymentStatus(row.employmentStatus) !== "RETIRED"
  );
  const now = new Date(deps.nowMs ?? Date.now());
  return attachDashboardFreshness(
    {
      date: ymd,
      reconstructedFromCurrentRoster: true,
      snapshotAvailable: false,
      capturedAt: null,
      source: "live",
      isPastDate: deps.isPastDate === true,
      sourceQuality: "fallback",
      roster: countActiveRoster(visible),
      availability: {
        finalAvailable: 0,
        houseAvailable: 0,
        thirdAvailable: 0,
        offCount: 0,
        reasonCounts: [],
      },
      opsDuties: groupOpsDutyNames(stored),
      caddies: visible.map(pendingAdminOpsCaddyRow),
      freshness: "refreshing",
      sourceAsOf: null,
      generatedAt: now.toISOString(),
      sheetDerivedReady: false,
    },
    {
      freshness: "refreshing",
      sourceAsOf: null,
      generatedAt: now.toISOString(),
      sheetDerivedReady: false,
    }
  );
}

async function loadFromWarmSheetPeek(
  ymd: string,
  deps: AdminOpsDashboardFastPathDeps
): Promise<AdminOpsDashboardFreshView | null> {
  const offPeek = peekCachedOffSheetsForDate(ymd);
  if (!offPeek) return null;
  const opsPeek = peekCachedOpsDutySheets();
  const loaded = await loadAdminOpsDashboardWithSource(ymd, {
    ...deps,
    fetchOffSheets: async () => offPeek,
    fetchOpsDutySheets: async () => opsPeek ?? [],
  });
  if (loaded.offSource !== "sheet") return null;
  if (loaded.dutySource === "none" && opsPeek == null) return null;
  const now = new Date(deps.nowMs ?? Date.now());
  const view = attachDashboardFreshness(
    dashboardViewFromLive(loaded.dashboard, deps.isPastDate === true, loaded.quality),
    {
      freshness: "fresh",
      sourceAsOf: now.toISOString(),
      generatedAt: now.toISOString(),
      sheetDerivedReady: true,
    }
  );
  rememberAdminOpsDashboardSuccess(view, deps.nowMs ?? Date.now());
  return view;
}

export async function loadAdminOpsDashboardFastView(
  ymd: string,
  deps: AdminOpsDashboardFastPathDeps = {}
): Promise<AdminOpsDashboardFreshView> {
  parseYmd(ymd);
  const nowMs = deps.nowMs ?? Date.now();
  const peeked = await loadFromWarmSheetPeek(ymd, deps);
  if (peeked) return peeked;
  const last = lastSuccessViewForDate(ymd, nowMs);
  if (last) return last;
  return loadAdminOpsDashboardDbFirst(ymd, deps);
}

export async function loadAdminOpsDashboardRefreshView(
  ymd: string,
  deps: AdminOpsDashboardFastPathDeps = {}
): Promise<AdminOpsDashboardFreshView> {
  parseYmd(ymd);
  const nowMs = deps.nowMs ?? Date.now();
  const previous = peekAdminOpsDashboardLastSuccess(ymd, nowMs)?.view ?? null;
  try {
    const loaded = await loadAdminOpsDashboardWithSource(ymd, deps);
    if (loaded.offSource !== "sheet") {
      if (previous) {
        return {
          ...previous,
          freshness: "error",
          generatedAt: new Date(nowMs).toISOString(),
        };
      }
      const fallback = await loadAdminOpsDashboardDbFirst(ymd, deps);
      return { ...fallback, freshness: "error" };
    }
    if (shouldKeepPreviousDashboardSuccess(previous, loaded.quality) && previous) {
      return {
        ...previous,
        freshness: "error",
        generatedAt: new Date(nowMs).toISOString(),
      };
    }
    const now = new Date(nowMs);
    const view = attachDashboardFreshness(
      dashboardViewFromLive(loaded.dashboard, deps.isPastDate === true, loaded.quality),
      {
        freshness: "fresh",
        sourceAsOf: now.toISOString(),
        generatedAt: now.toISOString(),
        sheetDerivedReady: true,
      }
    );
    rememberAdminOpsDashboardSuccess(view, nowMs);
    return view;
  } catch (error) {
    if (previous) {
      return {
        ...previous,
        freshness: "error",
        generatedAt: new Date(nowMs).toISOString(),
      };
    }
    try {
      const fallback = await loadAdminOpsDashboardDbFirst(ymd, deps);
      return { ...fallback, freshness: "error" };
    } catch {
      throw error;
    }
  }
}
