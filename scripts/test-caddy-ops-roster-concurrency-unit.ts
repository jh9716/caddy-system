/**
 * /api/summary/ops-roster 상태 표시 + 동시 접속 Sheet/DB 조회 횟수 (합성·로컬).
 * 실행: npm run test:caddy-ops-roster-concurrency-unit
 */
import { loadAdminOpsDashboardView } from "../src/lib/dailyOpsSnapshotService";
import { resetAdminOpsDashboardLastSuccessForTests } from "../src/lib/adminOpsDashboardFreshness";
import {
  getOffSheetHttpFetchCount, invalidateOffSheetCache, resetOffSheetHttpStatsForTests, setPublishedOffSheetLoaderForTests,
} from "../src/lib/offSheetFetch";
import {
  getOpsDutySheetHttpFetchCount, invalidateOpsDutySheetCache, resetOpsDutySheetHttpStatsForTests, setPublishedOpsDutySheetLoaderForTests,
} from "../src/lib/opsDutySheetFetch";
import { buildOpsDutySheetTestSheets } from "../src/lib/opsDutySheetParser";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import { buildTeamSlotGrid } from "../src/lib/availabilitySlotGrid";
import type { AvailabilityWithSlotGrid } from "../src/lib/availabilityService";
import {
  caddyOpsDisplayState, caddyOpsRowState, caddyOpsStatText, toCaddyOpsRoster, type CaddyOpsRosterPayload,
} from "../src/lib/caddyOpsRoster";
import {
  CADDY_OPS_FRESH_MEMO_MS, loadCaddyOpsRosterShared, resetCaddyOpsRosterServerForTests,
} from "../src/lib/caddyOpsRosterServer";

let passed = 0, failed = 0;
function assert(c: unknown, m: string) { if (c) { passed++; console.log("  ✓", m); } else { failed++; console.error("  ✗", m); } }

const DATE = "2026-11-04";
const roster = [1, 2, 3, 4, 5].map((id) => ({ id, name: `합성${id}`, team: `${id}조`, employmentStatus: "ACTIVE", caddyType: "HOUSE" }));
let dbCalls = 0;
let sheetFail = false;
function avail(ymd: string): AvailabilityWithSlotGrid {
  const base = computeAvailability({ date: ymd, caddies: roster.map((r, i) => ({ ...r, teamOrder: i + 1, extraFlags: [], thirdBandSubgroup: null })), assignments: [], extraTags: [] });
  const ov = applyDailyExternalExclusions({ availability: base, caddies: roster, offNames: ["합성5"], dutyEntries: [] });
  return { ...ov, slotGrid: buildTeamSlotGrid({ availability: ov, occupants: roster.map((r, i) => ({ id: r.id, name: r.name, team: r.team, teamOrder: i + 1, employmentStatus: r.employmentStatus })) }) };
}
const sourceDeps = {
  loadAvailability: async (ymd: string) => { dbCalls++; await new Promise((r) => setTimeout(r, 20)); return avail(ymd); },
  listDuties: async () => { dbCalls++; return [{ id: 1, role: "DUTY_AM" as const, roleKey: "당번_조출_1", caddyId: 1, rawName: "합성1", name: "합성1", team: "1조", employmentStatus: "ACTIVE" }]; },
  listMonthlyMarshal: async () => { dbCalls++; return []; },
};
const loader = (d: string, o: { waitForSheet: boolean }) =>
  loadAdminOpsDashboardView(d, { sourceDeps, listRoster: async () => { dbCalls++; return roster; }, waitForSheet: o.waitForSheet, now: new Date("2026-11-04T01:00:00Z") });

function resetAll() {
  invalidateOffSheetCache(); invalidateOpsDutySheetCache(); resetOffSheetHttpStatsForTests(); resetOpsDutySheetHttpStatsForTests();
  resetAdminOpsDashboardLastSuccessForTests(); resetCaddyOpsRosterServerForTests(); dbCalls = 0;
}
setPublishedOffSheetLoaderForTests(async () => {
  await new Promise((r) => setTimeout(r, 50));
  if (sheetFail) throw new Error("off_sheet_fetch_failed");
  return [{ name: "1104", matrix: [["2026.11.04 (수)", "", ""], ["1조", "2조", "3조"], ["", "", ""]] }];
});
setPublishedOpsDutySheetLoaderForTests(async () => {
  await new Promise((r) => setTimeout(r, 50));
  if (sheetFail) throw new Error("ops_duty_sheet_failed");
  return buildOpsDutySheetTestSheets([{ name: "0101~0114", startDate: "2099-01-01",
    week1Dates: ["2099-01-01","2099-01-02","2099-01-03","2099-01-04","2099-01-05","2099-01-06","2099-01-07"],
    week2Dates: ["2099-01-08","2099-01-09","2099-01-10","2099-01-11","2099-01-12","2099-01-13","2099-01-14"], week1Names: [{}] }]);
});
const sheets = () => getOffSheetHttpFetchCount() + getOpsDutySheetHttpFetchCount();
const N = 50;
const report: string[] = [];

async function main() {
  console.log("\n== 화면 상태 판정 ==");
  const P = (ready: boolean, freshness: CaddyOpsRosterPayload["freshness"]) => ({ ready, freshness });
  assert(caddyOpsDisplayState(null, { inFlight: true, requestFailed: false }) === "loading", "응답 전 → 조회 진행 중");
  assert(caddyOpsDisplayState(null, { inFlight: false, requestFailed: true }) === "failed", "응답 없음+실패 → 조회 실패");
  assert(caddyOpsDisplayState(P(true, "fresh"), { inFlight: false, requestFailed: false }) === "ok", "ready+fresh → 정상");
  assert(caddyOpsDisplayState(P(false, "refreshing"), { inFlight: true, requestFailed: false }) === "refreshing", "fast 미준비+refresh 진행 → 확인 중");
  assert(caddyOpsDisplayState(P(false, "error"), { inFlight: false, requestFailed: false }) === "refresh_failed", "HTTP200+error+ready=false → 갱신 실패 (영구 '확인 중' 아님)");
  assert(caddyOpsDisplayState(P(true, "error"), { inFlight: false, requestFailed: false }) === "refresh_failed", "HTTP200+error+이전 성공 → 갱신 실패 (최신처럼 표시 안 함)");
  assert(caddyOpsDisplayState(P(true, "stale"), { inFlight: false, requestFailed: false }) === "refresh_failed", "stale → 갱신 실패");
  assert(caddyOpsDisplayState(P(false, "refreshing"), { inFlight: false, requestFailed: false }) === "refresh_failed", "refresh 후에도 refreshing → 갱신 실패");
  assert(caddyOpsDisplayState(P(true, "fresh"), { inFlight: false, requestFailed: true }) === "refresh_failed", "refresh HTTP 실패 → 갱신 실패");
  assert(caddyOpsRowState({ count: 0 }, { ready: true }, "ok") === "unassigned", "정상+0 → 실제 미배정");
  assert(caddyOpsRowState({ count: 0 }, { ready: false }, "refreshing") === "pending", "진행 중+0 → 정보 확인 중");
  assert(caddyOpsRowState({ count: 0 }, { ready: false }, "refresh_failed") === "unknown", "미준비+갱신 실패+0 → 확인 불가 (미배정 아님)");
  assert(caddyOpsRowState({ count: 0 }, { ready: true }, "refresh_failed") === "unassigned", "이전 성공 기준 미배정 (배너로 기준 시각 표시)");
  assert(caddyOpsStatText(null, "refresh_failed") === "갱신 실패" && caddyOpsStatText(null, "refreshing") === "확인 중", "통계 null 문구");
  assert(caddyOpsStatText(0, "ok") === "0명" && caddyOpsStatText(3, "failed") === "조회 실패", "실제 0명 / 조회 실패 구분");

  console.log("\n== 서버 refresh 실패 결과 (합성) ==");
  resetAll(); sheetFail = true;
  const coldFail = await loadCaddyOpsRosterShared(DATE, true, { loader });
  assert(coldFail.ready === false && coldFail.freshness === "error", "cold refresh 실패 → ready=false, freshness=error (HTTP 200 경로)");
  assert(coldFail.stats.finalAvailable === null && coldFail.stats.offCount === null, "가용·휴무 null (0 표시 안 함)");
  sheetFail = false;

  console.log(`\n== 동시 ${N}건: 기존 방식(직접 호출) vs 공유 ==`);
  for (const refresh of [false, true]) {
    resetAll();
    await Promise.all(Array.from({ length: N }, () => loader(DATE, { waitForSheet: refresh }).then(toCaddyOpsRoster)));
    const base = { sheet: sheets(), db: dbCalls };
    resetAll();
    const res = await Promise.all(Array.from({ length: N }, () => loadCaddyOpsRosterShared(DATE, refresh, { loader })));
    const shared = { sheet: sheets(), db: dbCalls };
    report.push(`${refresh ? "refresh=1" : "fast"} ${N}건: 기존 Sheet ${base.sheet}/DB ${base.db} → 공유 Sheet ${shared.sheet}/DB ${shared.db}`);
    console.log("   ", report[report.length - 1]);
    assert(shared.sheet <= 2, `공유: Sheet HTTP ≤2 (휴무·운영 각 1) [${shared.sheet}]`);
    assert(shared.db <= 4 && shared.db < base.db, `공유: DB 조회 1회분 [${shared.db}] < 기존 [${base.db}]`);
    assert(res.every((r) => JSON.stringify(r) === JSON.stringify(res[0])), "모든 응답 동일");
  }

  console.log("\n== fast+refresh 혼합 페이지 로드 2파 (각 50) ==");
  resetAll();
  await Promise.all(Array.from({ length: N }, () => loadCaddyOpsRosterShared(DATE, false, { loader })));
  await Promise.all(Array.from({ length: N }, () => loadCaddyOpsRosterShared(DATE, true, { loader })));
  report.push(`fast 50 → refresh 50: Sheet ${sheets()} / DB ${dbCalls}`);
  console.log("   ", report[report.length - 1]);
  assert(sheets() <= 2, "Sheet HTTP ≤2");

  console.log("\n== memo 만료 후 재조회 / Sheet 장애 폭주 방지 ==");
  resetAll();
  let t = 1_000_000;
  const clock = () => t;
  await loadCaddyOpsRosterShared(DATE, true, { loader, nowMs: clock });
  const db1 = dbCalls;
  t += CADDY_OPS_FRESH_MEMO_MS - 1;
  await loadCaddyOpsRosterShared(DATE, true, { loader, nowMs: clock });
  assert(dbCalls === db1, "15초 안: 재조회 없음");
  t += 2;
  await loadCaddyOpsRosterShared(DATE, true, { loader, nowMs: clock });
  assert(dbCalls > db1, "15초 후: 다시 조회 (관리자 변경 반영 지연 ≤15초)");
  resetAll(); sheetFail = true;
  for (let wave = 0; wave < 3; wave++) await Promise.all(Array.from({ length: N }, () => loader(DATE, { waitForSheet: true })));
  report.push(`기존 방식 Sheet 장애 중 refresh 50×3파: Sheet ${sheets()} / DB ${dbCalls}`);
  resetAll(); sheetFail = true; t = 2_000_000;
  for (let wave = 0; wave < 3; wave++) await Promise.all(Array.from({ length: N }, () => loadCaddyOpsRosterShared(DATE, true, { loader, nowMs: clock })));
  report.push(`Sheet 장애 중 refresh 50×3파(10초 안): Sheet ${sheets()} / DB ${dbCalls}`);
  console.log("   ", report[report.length - 1]);
  assert(sheets() <= 2, "장애 중 refresh 폭주 없음 (10초 실패 memo)");
  sheetFail = false;

  console.log("\n== 관리자와 같은 값 (공유 경로) ==");
  resetAll();
  const adminView = await loader(DATE, { waitForSheet: true });
  resetCaddyOpsRosterServerForTests();
  const caddy = await loadCaddyOpsRosterShared(DATE, true, { loader });
  assert(caddy.stats.activeCount === adminView.roster.activeCount && caddy.stats.finalAvailable === adminView.availability.finalAvailable && caddy.stats.offCount === adminView.availability.offCount,
    `재직 ${caddy.stats.activeCount}/가용 ${caddy.stats.finalAvailable}/휴무 ${caddy.stats.offCount} 관리자와 동일`);
  assert(adminView.opsDuties.every((g) => JSON.stringify(caddy.groups.find((c) => c.role === g.role)?.names) === JSON.stringify(g.names)), "명단 동일");

  console.log("\nREPORT:\n" + report.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
