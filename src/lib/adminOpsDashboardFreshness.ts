/**
 * /manage dashboard freshness. Process-memory last-success only.
 * DailyOpsSnapshot 의미/오늘 overwrite 없음. schema 변경 없음.
 */

import { OFF_SHEET_CACHE_MS } from "@/lib/offSheetFetch";
import type { AdminOpsDashboardView } from "@/lib/dailyOpsSnapshot";

export const DASHBOARD_SHEET_FRESH_MS = OFF_SHEET_CACHE_MS;

export type DashboardFreshness = "fresh" | "refreshing" | "stale" | "error";

export type AdminOpsDashboardFreshView = AdminOpsDashboardView & {
  freshness: DashboardFreshness;
  sourceAsOf: string | null;
  generatedAt: string;
  sheetDerivedReady: boolean;
};

type LastSuccessEntry = {
  ymd: string;
  view: AdminOpsDashboardFreshView;
  at: number;
};

const lastSuccessByDate = new Map<string, LastSuccessEntry>();

export function resetAdminOpsDashboardLastSuccessForTests() {
  lastSuccessByDate.clear();
}

export function isDashboardSheetFreshPayload(
  value: Pick<AdminOpsDashboardFreshView, "freshness" | "sheetDerivedReady" | "date"> | null | undefined
): boolean {
  return Boolean(value && value.freshness === "fresh" && value.sheetDerivedReady);
}

export function freshnessFromAge(ageMs: number, freshMs: number = DASHBOARD_SHEET_FRESH_MS): DashboardFreshness {
  return ageMs <= freshMs ? "fresh" : "stale";
}

export function attachDashboardFreshness(
  view: AdminOpsDashboardView,
  input: {
    freshness: DashboardFreshness;
    sourceAsOf: string | null;
    generatedAt?: string;
    sheetDerivedReady?: boolean;
  }
): AdminOpsDashboardFreshView {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return {
    ...view,
    freshness: input.freshness,
    sourceAsOf: input.sourceAsOf,
    generatedAt,
    sheetDerivedReady:
      input.sheetDerivedReady ?? (view.source !== "live" || input.freshness === "fresh"),
  };
}

export function rememberAdminOpsDashboardSuccess(
  view: AdminOpsDashboardFreshView,
  nowMs: number = Date.now()
): void {
  if (!view.date || !view.sheetDerivedReady) return;
  lastSuccessByDate.set(view.date, { ymd: view.date, view, at: nowMs });
}

export function peekAdminOpsDashboardLastSuccess(
  ymd: string,
  nowMs: number = Date.now()
): { view: AdminOpsDashboardFreshView; ageMs: number; at: number } | null {
  const entry = lastSuccessByDate.get(ymd);
  if (!entry || entry.view.date !== ymd) return null;
  return {
    view: entry.view,
    ageMs: Math.max(0, nowMs - entry.at),
    at: entry.at,
  };
}

export function lastSuccessViewForDate(
  ymd: string,
  nowMs: number = Date.now()
): AdminOpsDashboardFreshView | null {
  const hit = peekAdminOpsDashboardLastSuccess(ymd, nowMs);
  if (!hit) return null;
  const freshness = freshnessFromAge(hit.ageMs);
  return {
    ...hit.view,
    date: ymd,
    freshness,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

export function shouldKeepPreviousDashboardSuccess(
  previous: AdminOpsDashboardFreshView | null | undefined,
  nextQuality: "complete" | "fallback"
): boolean {
  return Boolean(
    previous &&
      previous.sheetDerivedReady &&
      previous.sourceQuality === "complete" &&
      nextQuality !== "complete"
  );
}
