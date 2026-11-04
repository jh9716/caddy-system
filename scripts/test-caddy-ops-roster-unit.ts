/**
 * 캐디 대시보드 운영 당번·마샬·조장 (read-only) — 관리자 view와 동일성/권한/개인정보.
 * 실행: npm run test:caddy-ops-roster-unit
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAdminOpsDashboardView, todayKstYmd } from "../src/lib/dailyOpsSnapshotService";
import { resetAdminOpsDashboardLastSuccessForTests } from "../src/lib/adminOpsDashboardFreshness";
import { invalidateOffSheetCache } from "../src/lib/offSheetFetch";
import { invalidateOpsDutySheetCache } from "../src/lib/opsDutySheetFetch";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import { buildTeamSlotGrid } from "../src/lib/availabilitySlotGrid";
import type { AvailabilityWithSlotGrid } from "../src/lib/availabilityService";
import type { StoredOpsDutyRow } from "../src/lib/dailyOpsDutyService";
import type { MonthlyMarshalDutyRow } from "../src/lib/marshalMonthDutySource";
import {
  caddyOpsRosterRowState,
  isCaddyOpsRosterPayload,
  toCaddyOpsRoster,
} from "../src/lib/caddyOpsRoster";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) { passed++; console.log("  ✓", msg); } else { failed++; console.error("  ✗", msg); }
}
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const DATE = "2026-11-04";
const NOW = new Date("2026-11-04T01:00:00Z"); // KST 10:00
const roster = [
  { id: 1, name: "김조출", team: "1조", employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  { id: 2, name: "이후출", team: "2조", employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  { id: 3, name: "박마샬", team: "1조", employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  { id: 4, name: "최마샬", team: "3조", employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  { id: 5, name: "정조장", team: "2조", employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  { id: 6, name: "한조장", team: "3조", employmentStatus: "ACTIVE", caddyType: "HOUSE" },
];
function avail(ymd: string): AvailabilityWithSlotGrid {
  const base = computeAvailability({
    date: ymd,
    caddies: roster.map((r, i) => ({ ...r, teamOrder: i + 1, extraFlags: [], thirdBandSubgroup: null })),
    assignments: [], extraTags: [],
  });
  const ov = applyDailyExternalExclusions({ availability: base, caddies: roster, offNames: ["한조장"], dutyEntries: [] });
  return { ...ov, slotGrid: buildTeamSlotGrid({ availability: ov,
    occupants: roster.map((r, i) => ({ id: r.id, name: r.name, team: r.team, teamOrder: i + 1, employmentStatus: r.employmentStatus })) }) };
}
function stored(id: number, role: StoredOpsDutyRow["role"], roleKey: string): StoredOpsDutyRow {
  const r = roster.find((x) => x.id === id)!;
  return { id: id * 10, role, roleKey, caddyId: id, rawName: r.name, name: r.name, team: r.team, employmentStatus: "ACTIVE" };
}
const storedRows = [
  stored(1, "DUTY_AM", "당번_조출_1"),
  stored(2, "DUTY_PM", "당번_후출_1"),
  stored(5, "LEADER", "조장_1"),
  stored(6, "LEADER", "조장_2"),
];
const monthly: MonthlyMarshalDutyRow[] = [
  { roleKey: "마샬_조출_1", role: "MARSHAL_AM", caddyId: 3, name: "박마샬", team: "1조", rawName: "박마샬", slotSource: "FINALIZED" },
  { roleKey: "마샬_후출_1", role: "MARSHAL_PM", caddyId: 4, name: "최마샬", team: "3조", rawName: "최마샬", slotSource: "FINALIZED" },
];
function deps(opts: { duties?: StoredOpsDutyRow[]; monthly?: MonthlyMarshalDutyRow[] } = {}) {
  return {
    loadAvailability: async (ymd: string) => avail(ymd),
    listDuties: async () => opts.duties ?? storedRows,
    listMonthlyMarshal: async () => opts.monthly ?? monthly,
    fetchOffSheets: async () => [{ name: "1104", matrix: [["2026.11.04 (수)", "", ""], ["1조", "2조", "3조"], ["", "", "한조장"]] }],
    fetchOpsDutySheets: async () => [],
  };
}
function reset() {
  invalidateOffSheetCache(); invalidateOpsDutySheetCache(); resetAdminOpsDashboardLastSuccessForTests();
}

async function main() {
  console.log("\n== 관리자 view와 동일 결과 (같은 loadAdminOpsDashboardView) ==");
  for (const waitForSheet of [true, false]) {
    reset();
    const view = await loadAdminOpsDashboardView(DATE, { now: NOW, sourceDeps: deps(), listRoster: async () => roster, waitForSheet });
    const pub = toCaddyOpsRoster(view);
    assert(pub.date === view.date, `date 동일 (waitForSheet=${waitForSheet})`);
    for (const g of view.opsDuties) {
      const c = pub.groups.find((x) => x.role === g.role)!;
      assert(JSON.stringify(c.names) === JSON.stringify(g.names) && c.count === g.names.length,
        `${g.label} 이름/인원 동일 [${g.names.join(",")}] (waitForSheet=${waitForSheet})`);
    }
    assert(pub.stats.activeCount === view.roster.activeCount, `재직 동일 ${pub.stats.activeCount} (waitForSheet=${waitForSheet})`);
    if (view.sheetDerivedReady) {
      assert(pub.stats.finalAvailable === view.availability.finalAvailable, `가용 동일 ${pub.stats.finalAvailable}`);
      assert(pub.stats.offCount === view.availability.offCount, `휴무 동일 ${pub.stats.offCount}`);
    } else {
      assert(pub.stats.finalAvailable === null && pub.stats.offCount === null, "미준비: 가용·휴무 null (0 아님, 관리자 '—'와 동일)");
    }
    if (waitForSheet) {
      assert(pub.stats.offCount === 1, "합성 휴무 1명 (한조장)");
      assert(pub.stats.activeCount === 6, "합성 재직 6명");
      const by = Object.fromEntries(pub.groups.map((g) => [g.role, g.names]));
      assert(by.DUTY_AM?.join() === "김조출", "조출 당번 김조출");
      assert(by.DUTY_PM?.join() === "이후출", "후출 당번 이후출");
      assert(by.MARSHAL_AM?.join() === "박마샬", "조출 마샬 박마샬 (FINALIZED 월표)");
      assert(by.MARSHAL_PM?.join() === "최마샬", "후출 마샬 최마샬");
      assert(by.LEADER?.length === 2 && pub.groups.find((g) => g.role === "LEADER")!.count === 2, "조장 2명");
    }
  }

  console.log("\n== 5개 역할 고정 순서 / 데이터 없음 ==");
  reset();
  const empty = await loadAdminOpsDashboardView(DATE, { now: NOW, sourceDeps: deps({ duties: [], monthly: [] }), listRoster: async () => roster, waitForSheet: true });
  const ep = toCaddyOpsRoster(empty);
  assert(ep.groups.map((g) => g.label).join("|") === "조출 당번|후출 당번|조출 마샬|후출 마샬|조장", "라벨 5개 순서");
  assert(ep.groups.every((g) => g.count === 0), "데이터 없음 → 0명");
  assert(ep.groups.every((g) => caddyOpsRosterRowState(g, ep.ready) === (ep.ready ? "unassigned" : "pending")), "빈 행 상태: ready면 미배정");
  assert(caddyOpsRosterRowState({ count: 0 }, true) === "unassigned", "ready+0 → 미배정");
  assert(caddyOpsRosterRowState({ count: 0 }, false) === "pending", "미준비+0 → 정보 확인 중");
  assert(caddyOpsRosterRowState({ count: 2 }, false) === "assigned", "이름 있으면 표시");
  const partial = toCaddyOpsRoster({ date: DATE, opsDuties: [{ role: "LEADER", label: "조장", names: [" 가 ", ""] }], sheetDerivedReady: true, freshness: "fresh", sourceAsOf: null });
  assert(partial.groups.length === 5 && partial.groups[4].count === 1, "누락 역할 보충·빈 이름 제거");

  console.log("\n== 개인정보 최소화 ==");
  reset();
  const v = await loadAdminOpsDashboardView(DATE, { now: NOW, sourceDeps: deps(), listRoster: async () => roster, waitForSheet: true });
  const json = JSON.stringify(toCaddyOpsRoster(v));
  for (const bad of ["caddyId", "phone", "username", "employmentStatus", "rawName", "team", "\"id\"", "caddies", "accounts"]) {
    assert(!json.includes(bad), `응답에 ${bad} 없음`);
  }
  assert(Object.keys(toCaddyOpsRoster(v)).sort().join() === "date,freshness,groups,ok,ready,sourceAsOf,stats", "최상위 키 제한");
  assert(Object.keys(toCaddyOpsRoster(v).stats).sort().join() === "activeCount,finalAvailable,offCount", "stats 키 제한 (병가·장기병가 미제공)");
  assert(!/sick/i.test(json), "sick 필드 없음");
  assert(isCaddyOpsRosterPayload(JSON.parse(json)), "payload 형식 검사 통과");
  assert(!isCaddyOpsRosterPayload({ error: "x" }) && !isCaddyOpsRosterPayload(null) && !isCaddyOpsRosterPayload("<html>"), "오류/HTML 형식 거부");

  console.log("\n== KST 날짜 ==");
  assert(todayKstYmd(new Date("2026-11-03T15:30:00Z")) === "2026-11-04", "UTC 15:30 → KST 다음날");
  assert(todayKstYmd(new Date("2026-11-04T14:59:00Z")) === "2026-11-04", "UTC 14:59 → KST 같은날");

  console.log("\n== route 정적 검사 ==");
  const route = src("src/app/api/summary/ops-roster/route.ts");
  assert(/requireNoticeReader\(req\)/.test(route), "caddy/leader/admin 로그인 필수 (비로그인 401)");
  assert(/loadCaddyOpsRosterShared\(/.test(route) && /loadAdminOpsDashboardView\(/.test(src("src/lib/caddyOpsRosterServer.ts")), "관리자와 같은 view 로더 사용 (공유 memo 경유)");
  assert(/todayKstYmd\(\)/.test(route) && !/searchParams\.get\("date"\)/.test(route), "KST 오늘 고정, date 파라미터 없음");
  assert(!/export async function (POST|PUT|PATCH|DELETE)/.test(route), "write 메서드 없음 (405)");
  assert(!/prisma\.|\.create\(|\.update\(|\.delete\(|\.upsert\(/.test(route), "route에 DB write 없음");
  const admin = src("src/app/api/manage/dashboard/route.ts");
  assert(/requireAdmin\(req\)/.test(admin), "관리자 API는 requireAdmin 유지");
  const comp = src("src/components/caddy/CaddyOpsRosterSection.tsx");
  assert(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(comp) && !/manage\/dashboard/.test(comp), "캐디 컴포넌트는 GET만, 관리자 API 미호출");
  for (const label of ["미배정", "정보 확인 중", "조회 실패", "다시 시도"]) assert(comp.includes(label), `상태 문구 '${label}'`);
  const page = src("src/app/caddy/page.tsx");
  assert(!/summary\.today\./.test(page), "캐디 '오늘 현황'은 /api/summary Assignment 집계를 쓰지 않음");
  assert(!/label="당번"|label="마샬"|label="병가"/.test(page), "당번·마샬·병가 숫자 카드 제거");
  for (const k of ["재직 캐디", "해당일 가용", "병가·장기병가 미제공", "조회 실패"]) assert(comp.includes(k), `통계 문구 '${k}'`);
  assert((comp.match(/fetch\(/g) || []).length === 1, "통계·명단 단일 fetch 함수");
  for (const k of ["최근 공지", "월간 휴무 신청", "CaddyOpsRosterSection"]) assert(page.includes(k), `캐디 대시보드 유지/추가: ${k}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
