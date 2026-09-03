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
  groupOpsDutyNames,
} from "../src/lib/adminOpsDashboard";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import { AdminOpsCaddyGrid } from "../src/components/manage/AdminOpsDashboard";
import { addDaysYmd } from "../src/lib/dailyBoardPublished";

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
}

section("전체 캐디 grid 가용/제외");
{
  const dash = buildAdminOpsDashboard({
    date: "2026-09-16",
    availability: availabilityFor("2026-09-16"),
    opsDuties: [
      { role: "DUTY_AM", name: "김가용" },
      { role: "LEADER", name: "박3부" },
    ],
  });
  assert(!dash.caddies.some((c) => c.name === "오퇴사"), "RETIRED는 grid에서 제외");
  const off = dash.caddies.find((c) => c.name === "이휴무")!;
  const duty = dash.caddies.find((c) => c.name === "김가용")!;
  const sick = dash.caddies.find((c) => c.name === "최병가")!;
  const leave = dash.caddies.find((c) => c.name === "강휴직")!;
  assert(off.status === "excluded" && off.reasons.includes("휴무"), "휴무 제외");
  assert(duty.status === "excluded" && duty.reasons.includes("조출당번"), "당번 제외 reason");
  assert(sick.status === "excluded" && sick.reasons.includes("병가"), "병가 제외");
  assert(leave.status === "excluded", "휴직 제외");
  const html = renderToStaticMarkup(
    createElement(AdminOpsCaddyGrid, { rows: dash.caddies })
  );
  assert(html.includes("이휴무") && html.includes("휴무"), "grid에 이름/reason");
  assert(html.includes("data-status=\"excluded\""), "제외 badge");
  assert(html.includes("3부반"), "HOUSE/3부반 표시");
  assert(html.includes("dash-caddy-grid"), "grid class");
  const named = filterDashboardCaddies(dash.caddies, "김");
  assert(named.length === 1 && named[0].name === "김가용", "이름 검색만");
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

section("dashboard 조회 write/sync 없음");
{
  const service = readSrc("src/lib/adminOpsDashboardService.ts");
  const api = readSrc("src/app/api/manage/dashboard/route.ts");
  const helper = readSrc("src/lib/adminOpsDashboard.ts");
  const page = readSrc("src/app/manage/page.tsx");
  const ui = readSrc("src/components/manage/AdminOpsDashboard.tsx");
  const getFn = api.split("export async function GET")[1] || "";

  assert(/includeOffSheet: false/.test(service), "휴무 Sheet fetch 끔");
  assert(/includeStoredOpsDuty: true/.test(service), "저장된 DailyOpsDuty만 읽음");
  assert(/loadAvailabilityForDate/.test(service), "기존 availability loader 재사용");
  assert(/listDailyOpsDuties/.test(service), "기존 ops duty read helper");
  assert(!/fetchPublishedOffSheets/.test(service), "service가 sheet fetch 안 함");
  assert(!/syncOpsDutySheet/.test(service + api + helper + page + ui), "autosync 없음");
  assert(!/replaceDailyOpsDuties/.test(service + api + helper), "DailyOpsDuty write 없음");
  assert(!/publishDailyBoard/.test(service + api + helper), "Published write 없음");
  assert(!/autoAssignEngine/.test(service + api + helper + ui), "autoAssignEngine 미사용");
  assert(!/dailyBoardPublished/.test(ui), "dashboard UI가 published payload를 쓰지 않음");
  assert(!/export async function POST/.test(api), "dashboard API는 GET만");
  assert(/method: "GET"/.test(ui), "클라이언트도 GET만");
  assert(!/prisma\.(create|update|upsert|delete)/.test(getFn), "GET에 prisma write 없음");
  assert(/loadAdminOpsDashboard/.test(getFn), "GET이 read helper 사용");
}

section("모바일 폭 rendering 구조");
{
  const css = readSrc("src/app/globals.css");
  const ui = readSrc("src/components/manage/AdminOpsDashboard.tsx");
  assert(/\.dash-caddy-grid\s*\{[^}]*repeat\(2/.test(css), "모바일 2열 grid");
  assert(/@media \(min-width: 720px\)[\s\S]*dash-caddy-grid[\s\S]*repeat\(4/.test(css), "PC 4열");
  assert(/@media \(min-width: 1100px\)[\s\S]*dash-caddy-grid[\s\S]*repeat\(6/.test(css), "넓은 PC 6열");
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
