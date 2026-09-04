/**
 * 관리자 대시보드 V2 Phase 1 (엔진/DB write 없음)
 * 실행: npm run test:admin-ops-dashboard-unit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as { React?: typeof React }).React = React;

import {
  buildAdminOpsDashboard,
  countActiveRoster,
  countOffFromReasons,
  filterDashboardCaddies,
  groupCaddiesByPrimaryTeam,
  groupOpsDutyNames,
  statusToneFromReasons,
} from "../src/lib/adminOpsDashboard";
import { loadAdminOpsDashboardSource } from "../src/lib/adminOpsDashboardSource";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import { AdminOpsDutyBoard, AdminOpsTeamBoard, TeamBoardPerson } from "../src/components/manage/AdminOpsDashboard";
import { addDaysYmd } from "../src/lib/dailyBoardPublished";
import { PRIMARY_TEAMS } from "../src/lib/caddyManage";
import type { StoredOpsDutyRow } from "../src/lib/dailyOpsDutyService";
import { offNamesForDate, type OffSheet } from "../src/lib/offSheetParser";
import {
  buildOpsDutySheetTestSheets,
} from "../src/lib/opsDutySheetParser";

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

const caddies = [
  {
    id: 1,
    name: "김가용",
    team: "1조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE" as const,
  },
  {
    id: 2,
    name: "이휴무",
    team: "2조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE" as const,
  },
  {
    id: 3,
    name: "박3부",
    team: "9조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "THIRD" as const,
  },
  {
    id: 4,
    name: "최병가",
    team: "3조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE" as const,
  },
  {
    id: 5,
    name: "강휴직",
    team: "4조",
    teamOrder: 1,
    employmentStatus: "LEAVE",
    caddyType: "HOUSE" as const,
  },
  {
    id: 6,
    name: "오퇴사",
    team: "5조",
    teamOrder: 1,
    employmentStatus: "RETIRED",
    caddyType: "HOUSE" as const,
  },
];

function offSheetForDate(ymd: string, names: string[]): OffSheet {
  const [y, m, d] = ymd.split("-");
  return {
    name: `${m}${d}`,
    matrix: [
      [`${y}.${m}.${d} (월)`, "", ""],
      ["1조", "2조", "3조"],
      [names[0] || "", names[1] || "", names[2] || ""],
    ],
  };
}

function storedDuty(name: string, role: StoredOpsDutyRow["role"] = "DUTY_AM"): StoredOpsDutyRow {
  return {
    id: 1,
    role,
    roleKey: role === "DUTY_AM" ? "당번_조출_1" : "조장_1",
    caddyId: 1,
    rawName: name,
    name,
    team: "1조",
    employmentStatus: "ACTIVE",
  };
}

function mockLoadAvailability(list = caddies) {
  return async (ymd: string, options?: {
    includeOffSheet?: boolean;
    offSheets?: OffSheet[];
    dutyEntries?: { kind: string; roleKey: string; rawName: string }[];
  }) => {
    const base = computeAvailability({ date: ymd, caddies: list, assignments: [] });
    const offNames =
      options?.includeOffSheet && options.offSheets
        ? offNamesForDate(options.offSheets, ymd).names
        : [];
    return applyDailyExternalExclusions({
      availability: base,
      caddies: list,
      offNames,
      dutyEntries: options?.dutyEntries ?? [],
    });
  };
}

function availabilityFor(date: string) {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(`${date}T23:59:59.999`);
  const base = computeAvailability({
    date,
    caddies,
    assignments: [
      { caddyId: 2, type: "OFF", startDate: start, endDate: end },
      { caddyId: 4, type: "SICK", startDate: start, endDate: end },
    ],
  });
  return applyDailyExternalExclusions({
    availability: base,
    caddies,
    offNames: [],
    dutyEntries: [
      { kind: "duty_am", roleKey: "당번_조출_1", rawName: "김가용" },
      { kind: "leader", roleKey: "조장_1", rawName: "박3부" },
    ],
  });
}

async function main() {
section("ACTIVE / HOUSE / 3부반 집계");
{
  const av = availabilityFor("2026-09-16");
  const rows = [...av.available.all, ...av.special, ...av.excluded];
  const roster = countActiveRoster(rows);
  assert(roster.activeCount === 4, "ACTIVE 4명 (LEAVE/RETIRED 제외)");
  assert(roster.houseCount === 3, "재직 HOUSE 3명");
  assert(roster.thirdCount === 1, "재직 3부반 1명");
}

section("선택 날짜 availability summary + OFF");
{
  const date = "2026-09-16";
  const av = availabilityFor(date);
  const dash = buildAdminOpsDashboard({
    date,
    availability: av,
    opsDuties: [
      { role: "DUTY_AM", name: "김가용" },
      { role: "LEADER", name: "박3부" },
    ],
  });
  assert(dash.date === date, "payload 날짜");
  assert(dash.availability.finalAvailable === av.dailySummary.finalAvailable, "finalAvailable 재사용");
  assert(dash.availability.houseAvailable === av.counts.byType.HOUSE, "HOUSE 가용은 counts.byType 재사용");
  assert(dash.availability.thirdAvailable === av.counts.byType.THIRD, "3부반 가용은 counts.byType 재사용");
  assert(dash.availability.offCount === 1, "휴무 1명");
  assert(countOffFromReasons(av.excluded) === 1, "OFF reason 집계");
  assert(
    dash.availability.reasonCounts.some((r) => r.reason === "병가" && r.count === 1),
    "기존 병가 reason만 표시"
  );
  assert(!dash.availability.reasonCounts.some((r) => r.reason === "미출근"), "임의 운영상태 없음");
}

section("DailyOpsDuty role/name");
{
  const groups = groupOpsDutyNames([
    { role: "DUTY_AM", name: "김가용" },
    { role: "DUTY_AM", name: "정조출" },
    { role: "MARSHAL_PM", name: "한후출" },
    { role: "LEADER", name: "박3부" },
  ]);
  const am = groups.find((g) => g.role === "DUTY_AM")!;
  assert(am.label === "조출 당번", "조출 당번 라벨");
  assert(am.names.join(" · ") === "김가용 · 정조출", "역할별 이름 나열");
  assert(groups.find((g) => g.role === "DUTY_PM")?.names.length === 0, "빈 역할은 0명");
  assert(groups.find((g) => g.role === "LEADER")?.names[0] === "박3부", "조장 이름");
  const dutyHtml = renderToStaticMarkup(createElement(AdminOpsDutyBoard, { groups }));
  assert(dutyHtml.includes("dash-ops-board") && dutyHtml.includes("dash-ops-row"), "compact 운영판");
  assert(dutyHtml.includes("조출 당번") && dutyHtml.includes("후출 당번"), "당번 한 행");
  assert(dutyHtml.includes("조출 마샬") && dutyHtml.includes("후출 마샬"), "마샬 한 행");
  assert(dutyHtml.includes("조장") && dutyHtml.includes("is-single"), "조장 단독 행");
  assert(dutyHtml.includes("김가용 · 정조출"), "당번 이름 나열");
  assert(dutyHtml.includes("2명") && dutyHtml.includes("dash-ops-count"), "인원은 보조");
  assert(!dutyHtml.includes("dash-duty-card") && !dutyHtml.includes("dash-duty-grid"), "큰 카드 5개 아님");
}

section("전체 캐디 조별 현황판 가용/제외");
{
  const dash = buildAdminOpsDashboard({
    date: "2026-09-16",
    availability: availabilityFor("2026-09-16"),
    opsDuties: [
      { role: "DUTY_AM", name: "김가용" },
      { role: "LEADER", name: "박3부" },
    ],
  });
  assert(!dash.caddies.some((c) => c.name === "오퇴사"), "RETIRED는 현황에서 제외");
  const off = dash.caddies.find((c) => c.name === "이휴무")!;
  const duty = dash.caddies.find((c) => c.name === "김가용")!;
  const sick = dash.caddies.find((c) => c.name === "최병가")!;
  const leave = dash.caddies.find((c) => c.name === "강휴직")!;
  const leader = dash.caddies.find((c) => c.name === "박3부")!;
  assert(off.status === "excluded" && off.reasons.includes("휴무"), "휴무 제외");
  assert(off.statusTone === "off", "휴무 tone");
  assert(duty.status === "excluded" && duty.reasons.includes("조출당번"), "당번 제외 reason");
  assert(duty.statusTone === "duty", "당번 tone");
  assert(sick.status === "excluded" && sick.reasons.includes("병가"), "병가 제외");
  assert(sick.statusTone === "sick", "병가 tone");
  assert(leader.statusTone === "leader", "조장 tone");
  assert(leave.status === "excluded", "휴직 제외");
  assert(statusToneFromReasons("available", []) === "available", "가용 tone");
  assert(statusToneFromReasons("excluded", ["조출마샬"]) === "marshal", "마샬 tone");
  const teams = groupCaddiesByPrimaryTeam(dash.caddies);
  assert(PRIMARY_TEAMS.every((t, i) => teams[i]?.team === t), "1조~12조 고정 컬럼");
  assert(teams[0].rows.some((r) => r.name === "김가용"), "1조에 김가용");
  assert(teams[8].rows.some((r) => r.name === "박3부"), "9조에 박3부");
  const html = renderToStaticMarkup(
    createElement(AdminOpsTeamBoard, { groups: teams })
  );
  assert(html.includes("이휴무") && html.includes("휴무"), "현황판에 이름/reason");
  assert(html.includes("dash-team-person-name") && html.includes("dash-team-person-reason"), "2줄 카드");
  assert(!html.includes("dash-team-person-sep"), "한 줄 · 합치기 없음");
  assert(html.includes("data-tone=\"off\""), "휴무 색상 tone");
  assert(html.includes("data-team=\"1조\"") && html.includes("data-team=\"12조\""), "조별 섹션");
  assert(!html.includes("dash-team-person-type"), "row에서 HOUSE/3부반 제거");
  assert(!html.includes("3부반"), "조별 현황에 3부반 반복 없음");
  const availableHtml = renderToStaticMarkup(
    createElement(TeamBoardPerson, {
      row: {
        ...off,
        name: "이제이",
        status: "available",
        statusLabel: "가용",
        statusTone: "available",
        reasons: [],
      },
    })
  );
  assert(availableHtml.includes("이제이") && availableHtml.includes("가용"), "가용은 이름/가용 2줄");
  assert(!availableHtml.includes("HOUSE"), "가용 카드에 HOUSE 없음");
  assert(html.includes("dash-team-board"), "조별 현황판 class");
  assert(!html.includes("dash-caddy-grid"), "사람 카드 grid 제거");
  const named = filterDashboardCaddies(dash.caddies, "김");
  assert(named.length === 1 && named[0].name === "김가용", "이름 검색만");
}

section("휴무 count source (OFF Sheet overlay + Assignment)");
{
  const date = "2026-09-03";
  const emptyAssign = computeAvailability({ date, caddies, assignments: [] });
  const storedOnly = applyDailyExternalExclusions({
    availability: emptyAssign,
    caddies,
    offNames: [],
    dutyEntries: [],
  });
  const sheetOverlay = applyDailyExternalExclusions({
    availability: emptyAssign,
    caddies,
    offNames: ["이휴무"],
    dutyEntries: [],
  });
  const noOff = buildAdminOpsDashboard({ date, availability: storedOnly });
  const withSheetNames = buildAdminOpsDashboard({ date, availability: sheetOverlay });
  assert(noOff.availability.offCount === 0, "Assignment OFF 없으면 overlay 전 휴무 0");
  assert(withSheetNames.availability.offCount === 1, "offNames overlay가 시트 휴무를 반영");
  const source = readSrc("src/lib/adminOpsDashboardSource.ts");
  assert(/fetchPublishedOffSheets/.test(source), "dashboard source는 휴무 Sheet를 읽음");
  assert(/includeOffSheet: offOk/.test(source), "OFF 날짜를 찾은 경우에만 overlay");
  assert(/countOffFromReasons/.test(readSrc("src/lib/adminOpsDashboard.ts")), "휴무 카드는 휴무 reason 집계");
}

section("날짜 변경 시 해당 날짜 데이터");
{
  const d1 = "2026-09-16";
  const d2 = addDaysYmd(d1, 1);
  const a1 = availabilityFor(d1);
  const a2 = computeAvailability({
    date: d2,
    caddies,
    assignments: [],
  });
  const overlaid2 = applyDailyExternalExclusions({
    availability: a2,
    caddies,
    offNames: [],
    dutyEntries: [],
  });
  const p1 = buildAdminOpsDashboard({ date: d1, availability: a1, opsDuties: [] });
  const p2 = buildAdminOpsDashboard({ date: d2, availability: overlaid2, opsDuties: [] });
  assert(p1.date !== p2.date, "날짜가 payload에 반영");
  assert(p1.availability.offCount === 1, "16일 휴무 반영");
  assert(p2.availability.offCount === 0, "다음날 휴무 없음");
  assert(p2.availability.finalAvailable > p1.availability.finalAvailable, "날짜별 가용 갱신");
}

section("read-only OFF/ops source overlay");
{
  const date = "2026-09-03";
  const writes: string[] = [];
  const loaded = await loadAdminOpsDashboardSource(date, {
    loadAvailability: mockLoadAvailability(),
    listDuties: async () => [storedDuty("김가용")],
    fetchOffSheets: async () => [offSheetForDate(date, ["이휴무"])],
    fetchOpsDutySheets: async () => {
      writes.push("unexpected_ops_fetch");
      return [];
    },
  });
  assert(loaded.dashboard.availability.offCount === 1, "OFF Sheet 휴무가 offCount에 반영");
  const offCaddy = loaded.dashboard.caddies.find((c) => c.name === "이휴무");
  assert(offCaddy?.status === "excluded" && offCaddy.statusTone === "off", "OFF Sheet 휴무가 캐디 상태에 반영");
  assert(loaded.offSource === "sheet" && loaded.quality === "complete", "OFF Sheet source complete");
  assert(writes.length === 0, "저장된 DailyOpsDuty가 있으면 운영배치 Sheet를 읽지 않음");
}

section("Sheet overlay는 DB write / apply 없음");
{
  const date = "2026-09-03";
  await loadAdminOpsDashboardSource(date, {
    loadAvailability: mockLoadAvailability(),
    listDuties: async () => [],
    fetchOffSheets: async () => [offSheetForDate(date, ["이휴무"])],
    fetchOpsDutySheets: async () =>
      buildOpsDutySheetTestSheets([
        {
          name: "0901~0914",
          startDate: date,
          week1Dates: [date, "2099-01-02", "2099-01-03", "2099-01-04", "2099-01-05", "2099-01-06", "2099-01-07"],
          week2Dates: ["2099-01-08", "2099-01-09", "2099-01-10", "2099-01-11", "2099-01-12", "2099-01-13", "2099-01-14"],
          week1Names: [{ 당번_조출_1: "김가용", 마샬_조출_1: "최병가", 조장_1: "박3부" }],
        },
      ]),
  });
  const src = readSrc("src/lib/adminOpsDashboardSource.ts") + readSrc("src/lib/adminOpsDashboardService.ts");
  assert(!/replaceDailyOpsDuties/.test(src), "replaceDailyOpsDuties 미사용");
  assert(!/applyDailyOpsDutySheet/.test(src), "applyDailyOpsDutySheet 미사용");
  assert(!/syncOpsDutySheet/.test(src), "syncOpsDutySheet 미사용");
  assert(!/prisma\.(create|update|upsert|delete|createMany)/.test(src), "source/service prisma write 없음");
}

section("DailyOpsDuty 없이 운영배치 Sheet read-only");
{
  const date = "2026-09-03";
  let opsFetch = 0;
  const loaded = await loadAdminOpsDashboardSource(date, {
    loadAvailability: mockLoadAvailability(),
    listDuties: async () => [],
    fetchOffSheets: async () => [offSheetForDate(date, ["이휴무"])],
    fetchOpsDutySheets: async () => {
      opsFetch += 1;
      return buildOpsDutySheetTestSheets([
        {
          name: "0901~0914",
          startDate: date,
          week1Dates: [date, "2099-01-02", "2099-01-03", "2099-01-04", "2099-01-05", "2099-01-06", "2099-01-07"],
          week2Dates: ["2099-01-08", "2099-01-09", "2099-01-10", "2099-01-11", "2099-01-12", "2099-01-13", "2099-01-14"],
          week1Names: [{ 당번_조출_1: "김가용", 마샬_조출_1: "최병가", 조장_1: "박3부" }],
        },
      ]);
    },
  });
  assert(opsFetch === 1, "저장된 duty가 없으면 운영배치 Sheet를 읽음");
  assert(loaded.dutySource === "sheet" && loaded.completeForSnapshot, "sheet duty로 snapshot 가능");
  const duty = loaded.dashboard.opsDuties.find((g) => g.role === "DUTY_AM");
  const marshal = loaded.dashboard.opsDuties.find((g) => g.role === "MARSHAL_AM");
  const leader = loaded.dashboard.opsDuties.find((g) => g.role === "LEADER");
  assert(duty?.names.includes("김가용"), "Sheet 당번 표시");
  assert(marshal?.names.includes("최병가"), "Sheet 마샬 표시");
  assert(leader?.names.includes("박3부"), "Sheet 조장 표시");
}

section("Sheet fetch 실패 시 DB fallback + incomplete metadata");
{
  const date = "2026-09-03";
  const loaded = await loadAdminOpsDashboardSource(date, {
    loadAvailability: mockLoadAvailability(),
    listDuties: async () => [storedDuty("김가용")],
    fetchOffSheets: async () => {
      throw new Error("off_sheet_fetch_failed");
    },
    fetchOpsDutySheets: async () => {
      throw new Error("ops should not run when stored duty exists");
    },
  });
  assert(loaded.quality === "fallback", "OFF fetch 실패 → fallback");
  assert(loaded.completeForSnapshot === false, "불완전 source는 snapshot 불가");
  assert(loaded.offSource === "assignment_only", "OFF는 Assignment만");
  assert(loaded.dashboard.availability.offCount === 0, "Sheet 실패 시 시트 휴무 0, 화면은 유지");
  assert(loaded.skipReason === "off_sheet_fetch_failed", "skipReason 노출");
}

section("dashboard 조회 write/sync 없음");
{
  const service = readSrc("src/lib/adminOpsDashboardService.ts");
  const source = readSrc("src/lib/adminOpsDashboardSource.ts");
  const api = readSrc("src/app/api/manage/dashboard/route.ts");
  const helper = readSrc("src/lib/adminOpsDashboard.ts");
  const page = readSrc("src/app/manage/page.tsx");
  const ui = readSrc("src/components/manage/AdminOpsDashboard.tsx");
  const getFn = api.split("export async function GET")[1] || "";

  assert(/loadAdminOpsDashboardSource/.test(service), "service가 공통 source 사용");
  assert(/fetchPublishedOffSheets/.test(source), "OFF Sheet read-only fetch");
  assert(/fetchPublishedOpsDutySheets/.test(source), "운영배치 Sheet read-only fetch");
  assert(/listDailyOpsDuties/.test(source), "기존 ops duty read helper");
  assert(/loadAvailabilityForDate/.test(source), "기존 availability loader 재사용");
  assert(!/syncOpsDutySheet/.test(source + service + api + helper + page + ui), "autosync 없음");
  assert(!/replaceDailyOpsDuties/.test(source + service + api + helper), "DailyOpsDuty write 없음");
  assert(!/publishDailyBoard/.test(source + service + api + helper), "Published write 없음");
  assert(!/autoAssignEngine/.test(source + service + api + helper + ui), "autoAssignEngine 미사용");
  assert(!/dailyBoardPublished/.test(ui), "dashboard UI가 published payload를 쓰지 않음");
  assert(!/export async function POST/.test(api), "dashboard API는 GET만");
  assert(/method: "GET"/.test(ui), "클라이언트도 GET만");
  assert(!/prisma\.(create|update|upsert|delete)/.test(getFn), "GET에 prisma write 없음");
  assert(/loadAdminOpsDashboard/.test(getFn), "GET이 read helper 사용");
  assert(!/captureDailyOpsSnapshot/.test(api), "GET이 snapshot write 안 함");
}

section("모바일 폭 rendering 구조");
{
  const css = readSrc("src/app/globals.css");
  const ui = readSrc("src/components/manage/AdminOpsDashboard.tsx");
  assert(/dash-kpi-ops/.test(ui) && /재직 캐디/.test(ui) && /해당일 가용 캐디/.test(ui), "상단 3카드");
  assert(/하우스 /.test(ui) && /3부반 /.test(ui) && /하우스 가용/.test(ui), "카드 보조 HOUSE/3부반");
  assert(!/label: "HOUSE"/.test(ui) && !/label: "최종 가용"/.test(ui), "구 5카드 분리 제거");
  assert(/AdminOpsTeamBoard/.test(ui) && !/AdminOpsCaddyGrid/.test(ui), "조별 현황판으로 교체");
  assert(/dash-duty-title/.test(ui), "당번 영역 큰 제목");
  assert(/AdminOpsDutyBoard/.test(ui) && /dash-ops-board/.test(ui), "당번 compact 운영판");
  assert(!/dash-duty-grid/.test(ui) && !/dash-duty-card/.test(ui), "당번 큰 카드 5개 제거");
  assert(/\.dash-team-board\s*\{[^}]*repeat\(4/.test(css), "모바일 조별 4열");
  assert(/minmax\(4\.5rem/.test(css), "조 column 최소폭 4.5rem");
  assert(/@media \(min-width: 720px\)[\s\S]*dash-team-board[\s\S]*repeat\(8/.test(css), "PC 조별 8열");
  assert(/@media \(min-width: 1100px\)[\s\S]*dash-team-board[\s\S]*repeat\(12/.test(css), "넓은 PC 12열");
  assert(/grid-template-rows:\s*auto auto/.test(css), "캐디 카드 2줄");
  assert(!/dash-team-person-sep/.test(css), "한 줄 구분자 없음");
  assert(/\.dash-kpi(?:\.dash-kpi-ops|-ops)\s*\{[^}]*repeat\(3,\s*minmax\(0, 1fr\)/.test(css), "요약 3열 전체 폭");
  assert(/@media \(min-width: 560px\)[\s\S]*dash-ops-row[\s\S]*minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css), "PC 당번/마샬 2열");
  assert(!/dash-duty-grid/.test(css), "당번 5열 카드 없음");
  assert(/is-off/.test(css) && /is-sick/.test(css) && /is-duty/.test(css), "휴무/병가/당번 색");
  assert(/is-marshal/.test(css) && /is-leader/.test(css) && /is-available/.test(css), "마샬/조장/가용 색");
  assert(/addDays\(/.test(ui) && /이전/.test(ui) && /type="date"/.test(ui), "날짜 이전/다음/input");
  assert(/캐디 이름 검색/.test(ui), "이름 검색만");
  assert(!/전화번호|차량번호/.test(ui), "전화/차량 검색 없음");
}

section("기존 관리자 dashboard access policy");
{
  const layout = readSrc("src/app/manage/layout.tsx");
  const mw = readSrc("src/middleware.ts");
  const api = readSrc("src/app/api/manage/dashboard/route.ts");
  const page = readSrc("src/app/manage/page.tsx");
  assert(/auth\.role !== "admin"/.test(layout), "layout admin only");
  assert(/role !== "admin"/.test(mw.split('pathname.startsWith("/manage")')[1] || mw), "middleware /manage admin");
  assert(/requireAdmin/.test(api), "dashboard GET requireAdmin");
  assert(/AdminOpsDashboard/.test(page), "/manage가 V2 대시보드 사용");
  assert(!/AppRole = /.test(api), "새 role 타입 없음");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
