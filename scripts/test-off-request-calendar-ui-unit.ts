/**
 * 캐디 월간 휴무 캘린더 UI 배선. DB 없음.
 *   npm run test:off-request-calendar-ui-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  offRequestWindowHint,
  offRequestWindowStatusLabel,
  shiftYearMonth,
} from "../src/lib/offRequestWindowUi";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function section(title: string) {
  console.log("\n==", title, "==");
}

section("labels");
{
  assert(offRequestWindowStatusLabel("DRAFT") === "준비 중", "DRAFT label");
  assert(offRequestWindowStatusLabel("OPEN") === "신청 중", "OPEN label");
  assert(offRequestWindowStatusLabel("ADJUSTING") === "조정 중", "ADJUSTING label");
  assert(offRequestWindowStatusLabel("FINALIZED") === "확정", "FINALIZED label");
  assert(offRequestWindowHint("DRAFT").includes("아직 휴무 신청 전"), "DRAFT hint");
  assert(offRequestWindowHint("ADJUSTING").includes("조정 중"), "ADJUSTING hint");
  assert(shiftYearMonth("2026-01", -1) === "2025-12", "shift year");
}

section("caddy calendar wiring");
{
  const client = read("src/app/off-requests/OffRequestCalendarClient.tsx");
  const page = read("src/app/off-requests/page.tsx");
  const layout = read("src/app/off-requests/layout.tsx");
  const mw = read("src/middleware.ts");
  const nav = read("src/lib/boardNav.ts");
  assert(page.includes("OffRequestCalendarClient"), "page uses calendar");
  assert(client.includes("/api/off-requests/calendar"), "loads calendar API");
  assert(client.includes("/api/off-requests/${moveId}/reschedule"), "reschedule API");
  assert(client.includes("/api/off-requests/${day.mine.id}/cancel"), "cancel API");
  assert(client.includes('"/api/off-requests"'), "submit API");
  assert(!client.includes("/approve"), "no approve UI");
  assert(!client.includes("/reject"), "no reject UI");
  assert(!client.includes("applicants"), "no applicants list");
  assert(!client.includes("caddy.name"), "no other caddy name field");
  assert(client.includes("approvedCount + day.requestedCount"), "UI uses occupied/limit");
  assert(client.includes("아직 휴무 신청 전") || client.includes("offRequestWindowHint"), "draft copy");
  assert(client.includes("조정 중") || client.includes("offRequestWindowHint"), "adjusting copy");
  assert(layout.includes("canUseOffRequestPages"), "layout auth");
  assert(mw.includes('pathname.startsWith("/off-requests")'), "middleware gate");
  assert(nav.includes('href: "/off-requests"'), "member menu");
  const windowSvc = read("src/lib/offRequestWindowService.ts");
  assert(windowSvc.includes('where: { id, status: "DRAFT" }'), "patch is conditional");
  assert(windowSvc.includes("where: { id, status: row.status }"), "transition is conditional");
  assert(windowSvc.includes("countApprovedOffForTeamDays"), "calendar uses Assignment OFF SoT");
  assert(windowSvc.includes("isOccupiedOverLimit"), "over uses approved+requested");
  assert(client.includes("offRequestWindowStatusLabel"), "caddy uses shared labels");
  assert(!client.includes("/manage/off-requests"), "caddy calendar is not admin page");
  const mig = read("prisma/migrations/20261001120000_off_request_window/migration.sql");
  assert(!/ALTER TABLE "OffRequest"/i.test(mig), "migration does not alter OffRequest columns");
  assert(!/updatedAt/i.test(mig.split("OffRequestWindow")[0] || ""), "no pre-window updatedAt drift");
}

if (failed > 0) {
  console.error(`\ncalendar-ui failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\ncalendar-ui passed: ${passed}`);
