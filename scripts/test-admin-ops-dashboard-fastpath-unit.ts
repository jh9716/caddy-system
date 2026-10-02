/**
 * /manage dashboard Sheet non-blocking fast path.
 * 실행: npm run test:admin-ops-dashboard-fastpath-unit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_PENDING_STATUS_LABEL } from "../src/lib/adminOpsDashboard";
import {
  loadAdminOpsDashboardDbFirst,
  loadAdminOpsDashboardFastView,
  loadAdminOpsDashboardRefreshView,
} from "../src/lib/adminOpsDashboardFastPath";
import {
  DASHBOARD_SHEET_FRESH_MS,
  isDashboardSheetFreshPayload,
  rememberAdminOpsDashboardSuccess,
  resetAdminOpsDashboardLastSuccessForTests,
  shouldKeepPreviousDashboardSuccess,
} from "../src/lib/adminOpsDashboardFreshness";
import { dashboardViewFromLive } from "../src/lib/dailyOpsSnapshot";
import { dashboardUpdatingCopy } from "../src/lib/pendingLoad";
import { dashboardSourceLine } from "../src/components/manage/AdminOpsDashboard";
import {
  getOffSheetHttpFetchCount,
  invalidateOffSheetCache,
  resetOffSheetHttpStatsForTests,
  seedOffSheetCacheForTests,
  setPublishedOffSheetLoaderForTests,
} from "../src/lib/offSheetFetch";
import {
  getOpsDutySheetHttpFetchCount,
  invalidateOpsDutySheetCache,
  resetOpsDutySheetHttpStatsForTests,
  seedOpsDutySheetCacheForTests,
  setPublishedOpsDutySheetLoaderForTests,
} from "../src/lib/opsDutySheetFetch";
import type { OffSheet } from "../src/lib/offSheetParser";
import type { AvailabilityWithSlotGrid } from "../src/lib/availabilityService";
import { buildTeamSlotGrid } from "../src/lib/availabilitySlotGrid";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

function readSrc(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const DATE_A = "2026-10-01";
const DATE_B = "2026-10-02";

const roster = [
  {
    id: 1,
    name: "김가용",
    team: "1조",
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
  },
  {
    id: 2,
    name: "이휴무",
    team: "2조",
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
  },
];

function offSheetsFor(ymd: string, names: string[]): OffSheet[] {
  const [y, m, d] = ymd.split("-");
  return [
    {
      name: `${m}${d}`,
      matrix: [
        [`${y}.${m}.${d} (월)`, "", ""],
        ["1조", "2조", "3조"],
        [names[0] || "", names[1] || "", names[2] || ""],
      ],
    },
  ];
}

function mockAvailability(ymd: string, offNames: string[] = []): AvailabilityWithSlotGrid {
  const base = computeAvailability({
    date: ymd,
    caddies: roster.map((row, index) => ({
      ...row,
      teamOrder: index + 1,
      extraFlags: [],
      thirdBandSubgroup: null,
    })),
    assignments: [],
    extraTags: [],
  });
  const overlaid = applyDailyExternalExclusions({
    availability: base,
    caddies: roster,
    offNames,
    dutyEntries: [],
  });
  return {
    ...overlaid,
    slotGrid: buildTeamSlotGrid({
      availability: overlaid,
      occupants: roster.map((row, index) => ({
        id: row.id,
        name: row.name,
        team: row.team,
        teamOrder: index + 1,
        employmentStatus: row.employmentStatus,
      })),
    }),
  };
}

function sourceDeps(opts?: {
  offNames?: string[];
  failOff?: boolean;
  failAll?: boolean;
  delayMs?: number;
  onOffFetch?: () => void;
}) {
  return {
    listRoster: async () => roster,
    listDuties: async () => [],
    loadAvailability: async (ymd: string) => mockAvailability(ymd, opts?.offNames ?? ["이휴무"]),
    fetchOffSheets: async () => {
      opts?.onOffFetch?.();
      if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts?.failOff || opts?.failAll) throw new Error("off_sheet_fetch_failed");
      return offSheetsFor(DATE_A, opts?.offNames ?? ["이휴무"]);
    },
    fetchOpsDutySheets: async () => {
      if (opts?.failAll) throw new Error("ops_duty_sheet_failed");
      return [];
    },
  };
}

function resetSheets() {
  invalidateOffSheetCache();
  invalidateOpsDutySheetCache();
  resetOffSheetHttpStatsForTests();
  resetOpsDutySheetHttpStatsForTests();
  setPublishedOffSheetLoaderForTests(null);
  setPublishedOpsDutySheetLoaderForTests(null);
  resetAdminOpsDashboardLastSuccessForTests();
}

async function runAsyncCases() {
section("fast path: DB-first, no Sheet HTTP");
{
  resetSheets();
  let offFetches = 0;
  const started = Date.now();
  const view = await loadAdminOpsDashboardFastView(DATE_A, sourceDeps({
    onOffFetch: () => {
      offFetches += 1;
    },
    delayMs: 80,
  }));
  const elapsed = Date.now() - started;
  assert(view.freshness === "refreshing", "cold fast freshness=refreshing");
  assert(view.sheetDerivedReady === false, "cold fast sheetDerivedReady=false");
  assert(view.sourceAsOf === null, "cold fast sourceAsOf null");
  assert(view.generatedAt.length > 0, "cold fast generatedAt");
  assert(view.roster.activeCount === 2, "DB roster known");
  assert(view.caddies.every((row) => row.statusLabel === DASHBOARD_PENDING_STATUS_LABEL), "status 확인 중");
  assert(offFetches === 0, "fast path does not fetch OFF sheet");
  assert(getOffSheetHttpFetchCount() === 0, "no OFF HTTP on fast");
  assert(elapsed < 50, `fast path not blocked by delayed sheet (${elapsed}ms)`);
}

section("refresh success remembers last-success");
{
  resetSheets();
  const view = await loadAdminOpsDashboardRefreshView(DATE_A, sourceDeps({ offNames: ["이휴무"] }));
  assert(view.freshness === "fresh", "refresh freshness=fresh");
  assert(view.sheetDerivedReady === true, "refresh sheet ready");
  assert(view.availability.offCount === 1, "refresh off count from sheet names");
  assert(isDashboardSheetFreshPayload(view), "fresh payload helper");
  const fast = await loadAdminOpsDashboardFastView(DATE_A, sourceDeps({
    onOffFetch: () => {
      throw new Error("fast must not fetch after last-success");
    },
  }));
  assert(fast.freshness === "fresh", "last-success within 45s is fresh");
  assert(fast.availability.offCount === 1, "last-success keeps sheet counts");
  assert(fast.sourceAsOf === view.sourceAsOf, "sourceAsOf preserved");
}

section("stale last-success + refresh failure keeps data");
{
  resetSheets();
  const first = await loadAdminOpsDashboardRefreshView(DATE_A, sourceDeps({ offNames: ["이휴무"] }));
  rememberAdminOpsDashboardSuccess(
    { ...first, freshness: "fresh" },
    Date.now() - DASHBOARD_SHEET_FRESH_MS - 1
  );
  const stale = await loadAdminOpsDashboardFastView(DATE_A, sourceDeps({
    onOffFetch: () => {
      throw new Error("stale fast must not fetch");
    },
  }));
  assert(stale.freshness === "stale", "aged last-success is stale");
  assert(stale.availability.offCount === 1, "stale keeps previous off count");
  const failed = await loadAdminOpsDashboardRefreshView(
    DATE_A,
    sourceDeps({ failOff: true, offNames: [] })
  );
  assert(failed.freshness === "error", "refresh fail + last complete → error");
  assert(failed.availability.offCount === 1, "error keeps previous counts");
  assert(failed.sheetDerivedReady === true, "error still displays last sheet data");
}

section("refresh fail without last-success stays DB-first, not 500");
{
  resetSheets();
  const view = await loadAdminOpsDashboardRefreshView(
    DATE_A,
    sourceDeps({ failAll: true })
  );
  assert(view.freshness === "error", "no last-success + fail → error");
  assert(view.sheetDerivedReady === false, "DB-first after fail");
  assert(view.roster.activeCount === 2, "roster remains");
}

section("date isolation");
{
  resetSheets();
  await loadAdminOpsDashboardRefreshView(DATE_A, sourceDeps({ offNames: ["이휴무"] }));
  const other = await loadAdminOpsDashboardFastView(DATE_B, {
    ...sourceDeps({
      onOffFetch: () => {
        throw new Error("10/2 fast must not use 10/1 sheet fetch");
      },
    }),
    listRoster: async () => roster,
    listDuties: async () => [],
  });
  assert(other.date === DATE_B, "10/2 payload date");
  assert(other.freshness === "refreshing", "10/2 has no last-success");
  assert(other.sheetDerivedReady === false, "10/1 success does not mark 10/2 ready");
}

section("warm peek compute, zero extra HTTP");
{
  resetSheets();
  seedOffSheetCacheForTests(offSheetsFor(DATE_A, ["이휴무"]));
  seedOpsDutySheetCacheForTests([]);
  const beforeOff = getOffSheetHttpFetchCount();
  const beforeOps = getOpsDutySheetHttpFetchCount();
  const view = await loadAdminOpsDashboardFastView(DATE_A, {
    listRoster: async () => roster,
    listDuties: async () => [],
    loadAvailability: async (ymd) => mockAvailability(ymd, ["이휴무"]),
    fetchOffSheets: async () => {
      throw new Error("warm peek must not call fetchOffSheets dep");
    },
    fetchOpsDutySheets: async () => {
      throw new Error("warm peek must not call fetchOpsDutySheets dep");
    },
  });
  assert(view.freshness === "fresh", "warm peek is fresh");
  assert(view.sheetDerivedReady === true, "warm peek sheet ready");
  assert(getOffSheetHttpFetchCount() === beforeOff, "warm peek no OFF HTTP");
  assert(getOpsDutySheetHttpFetchCount() === beforeOps, "warm peek no ops HTTP");
}

section("warm peek date-match + ops peek required");
{
  resetSheets();
  seedOffSheetCacheForTests(offSheetsFor(DATE_A, ["이휴무"]));
  const other = await loadAdminOpsDashboardFastView(DATE_B, {
    listRoster: async () => roster,
    listDuties: async () => [],
    loadAvailability: async (ymd) => mockAvailability(ymd, []),
    fetchOffSheets: async () => {
      throw new Error("other-date peek must not fetch");
    },
    fetchOpsDutySheets: async () => {
      throw new Error("other-date peek must not fetch ops");
    },
  });
  assert(other.freshness === "refreshing" && other.sheetDerivedReady === false, "other-date workbook is not fresh");
  assert(other.availability.offCount === 0, "unknown off stays 0+not ready");

  resetSheets();
  seedOffSheetCacheForTests(offSheetsFor(DATE_A, ["이휴무"]));
  const offOnly = await loadAdminOpsDashboardFastView(DATE_A, {
    listRoster: async () => roster,
    listDuties: async () => [],
    loadAvailability: async (ymd) => mockAvailability(ymd, ["이휴무"]),
    fetchOffSheets: async () => {
      throw new Error("off-only peek must not fetch");
    },
    fetchOpsDutySheets: async () => {
      throw new Error("off-only peek must not fetch ops");
    },
  });
  assert(offOnly.freshness === "refreshing" && offOnly.sheetDerivedReady === false, "OFF peek without ops peek is not fresh");
}

section("refresh keeps complete last-success when duty falls back");
{
  resetSheets();
  const stored = {
    id: 1,
    role: "DUTY_AM" as const,
    roleKey: "당번_조출_1",
    caddyId: 1,
    name: "김가용",
    rawName: "김가용",
    team: "1조",
    employmentStatus: "ACTIVE",
  };
  const first = await loadAdminOpsDashboardRefreshView(DATE_A, {
    ...sourceDeps({ offNames: ["이휴무"] }),
    listDuties: async () => [stored],
  });
  assert(first.freshness === "fresh" && first.sourceQuality === "complete", "complete last-success");
  const asOf = first.sourceAsOf;
  rememberAdminOpsDashboardSuccess(first, Date.now() - DASHBOARD_SHEET_FRESH_MS - 5);
  const replay = await loadAdminOpsDashboardFastView(DATE_A, {
    listRoster: async () => roster,
    listDuties: async () => [stored],
    fetchOffSheets: async () => {
      throw new Error("stale replay must not fetch");
    },
  });
  assert(replay.freshness === "stale", "aged last-success is stale not fresh");
  assert(replay.sourceAsOf === asOf, "sourceAsOf stays sheet-backed compute time");
  assert(replay.generatedAt !== first.generatedAt, "generatedAt is response build time");

  const dutyFail = await loadAdminOpsDashboardRefreshView(DATE_A, {
    listRoster: async () => roster,
    listDuties: async () => [],
    loadAvailability: async (ymd) => mockAvailability(ymd, ["이휴무"]),
    fetchOffSheets: async () => offSheetsFor(DATE_A, ["이휴무"]),
    fetchOpsDutySheets: async () => [],
  });
  assert(dutyFail.freshness === "error", "ops empty after complete → error, keep previous");
  assert(dutyFail.opsDuties.some((g) => g.names.includes("김가용")), "previous duty names kept");
}

section("keep-previous helper + UX copy");
{
  assert(
    shouldKeepPreviousDashboardSuccess(
      {
        date: DATE_A,
        sheetDerivedReady: true,
        sourceQuality: "complete",
      } as never,
      "fallback"
    ),
    "complete last wins over fallback refresh"
  );
  assert(
    dashboardUpdatingCopy({
      loading: false,
      hasData: true,
      staleDate: false,
      error: false,
      freshness: "refreshing",
    }) === "최신 확인 중…",
    "refreshing copy"
  );
  assert(
    dashboardUpdatingCopy({
      loading: false,
      hasData: true,
      staleDate: false,
      error: false,
      freshness: "error",
    }) === "최신 정보 확인 실패",
    "error copy"
  );
  assert(
    dashboardSourceLine({
      source: "live",
      snapshotAvailable: false,
      capturedAt: null,
      isPastDate: false,
      sourceQuality: "fallback",
      freshness: "refreshing",
      sourceAsOf: null,
    }) === "선택일 운영현황 · 최신 확인 중…",
    "source line refreshing"
  );
  assert(
    dashboardSourceLine({
      source: "live",
      snapshotAvailable: false,
      capturedAt: null,
      isPastDate: false,
      sourceQuality: "complete",
    }) === "선택일 운영현황 · 현재 운영자료 기준",
    "source line fresh complete unchanged"
  );
  assert(dashboardSourceLine(null) === "선택일 운영현황", "empty data does not claim latest");
}

section("wiring / no date-bundle / snapshot untouched");
{
  const route = readSrc("src/app/api/manage/dashboard/route.ts");
  const ui = readSrc("src/components/manage/AdminOpsDashboard.tsx");
  const service = readSrc("src/lib/dailyOpsSnapshotService.ts");
  const source = readSrc("src/lib/adminOpsDashboardSource.ts");
  const avail = readSrc("src/lib/availabilityService.ts");
  const snap = readSrc("src/lib/dailyOpsSnapshotService.ts");
  const assignments = readSrc("src/app/manage/assignments/page.tsx");
  const bundle = readSrc("src/lib/assignmentsDateBundle.ts");
  assert(/waitForSheet: refresh/.test(route), "GET refresh=1 waits for sheet");
  assert(/refresh=1/.test(ui), "client background refresh");
  assert(/No AbortSignal/.test(ui) && !/AbortController/.test(ui), "leave /manage does not abort refresh");
  assert(/최신 확인 중/.test(ui), "client 최신 확인 중");
  assert(/isDashboardSheetFreshPayload/.test(ui), "client writes cache only when fresh");
  assert(/loadAdminOpsDashboardFastView/.test(service), "view uses fast path");
  assert(/includeOffSheet !== false/.test(avail), "availability default still fetches sheet");
  assert(/dashboard fast path가 이 기본값을 바꾸면 안 됨/.test(avail), "availability comment");
  assert(!/overwrite|update\(/.test(snap.split("captureDailyOpsSnapshot")[1] ?? ""), "capture has no overwrite");
  assert(/if \(existing\)/.test(snap), "snapshot write-once");
  assert(!assignments.includes("adminOpsDashboardFastPath"), "assignments page untouched by fast path");
  assert(!bundle.includes("adminOpsDashboardFastPath"), "date-bundle untouched");
  assert(!ui.includes("offSheetFetch") && !ui.includes("adminOpsDashboardFastPath"), "dashboard UI stays client-safe");
  assert(
    !/from ["']@\/lib\/offSheetFetch["']/.test(readSrc("src/lib/adminOpsDashboardFreshness.ts")),
    "freshness module stays client-safe"
  );
  assert(!/prisma\.(create|update|upsert|delete)/.test(source), "dashboard source no prisma write");
  const dbFirst = await loadAdminOpsDashboardDbFirst(DATE_A, {
    listRoster: async () => roster,
    listDuties: async () => [
      {
        id: 9,
        role: "DUTY_AM",
        roleKey: "당번_조출_1",
        caddyId: 1,
        name: "김가용",
        rawName: "김가용",
        team: "1조",
        employmentStatus: "ACTIVE",
      },
    ],
  });
  assert(dbFirst.opsDuties.some((g) => g.role === "DUTY_AM" && g.names.includes("김가용")), "stored duty visible on DB-first");
  assert(dbFirst.availability.offCount === 0 && dbFirst.sheetDerivedReady === false, "unknown off stays 0+not ready");
}

section("types unused guard");
{
  const live = dashboardViewFromLive(
    {
      date: DATE_A,
      reconstructedFromCurrentRoster: true,
      roster: { activeCount: 1, houseCount: 1, thirdCount: 0 },
      availability: {
        finalAvailable: 1,
        houseAvailable: 1,
        thirdAvailable: 0,
        offCount: 0,
        reasonCounts: [],
      },
      opsDuties: [],
      caddies: [],
    },
    false,
    "complete"
  );
  assert(live.freshness === "fresh" && live.sheetDerivedReady === true, "live view defaults fresh");
}
}

void runAsyncCases()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
