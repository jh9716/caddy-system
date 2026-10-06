/**
 * 관리자 메뉴 정리: 메인 노출 vs 관리도구 허브. route 삭제는 없다.
 *   npm run test:admin-manage-nav-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  ADMIN_HIDDEN_FROM_MAIN_HREFS,
  ADMIN_MAIN_NAV,
  ADMIN_MAIN_NAV_HREFS,
  ADMIN_TOOL_ITEMS,
  activeAdminMainHref,
  ADMIN_LEGACY_TOOL_NOTE,
  ADMIN_LEGACY_TOOLS_SUMMARY,
  groupAdminToolItems,
  isAdminToolPath,
  legacyAdminToolItems,
  manageNavItems,
  manageToolItems,
  primaryAdminToolItems,
} from "../src/lib/adminManageNav";

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

console.log("== main menu order ==");
assert(
  ADMIN_MAIN_NAV_HREFS.join(",") ===
    [
      "/manage",
      "/manage/caddies",
      "/manage/off-requests",
      "/manage/assignments",
      "/board",
      "/notice",
      "/chat",
      "/course-reports",
      "/schedule",
      "/manage/tools",
    ].join(","),
  "main href order"
);
assert(
  ADMIN_MAIN_NAV.map((i) => i.label).join(",") ===
    "대시보드,캐디 관리,휴무 신청,자동배치,배치표,공지,채팅,코스 제보,스케줄,관리도구",
  "main labels"
);

console.log("== tools stay off the main nav ==");
for (const href of ADMIN_HIDDEN_FROM_MAIN_HREFS) {
  assert(!ADMIN_MAIN_NAV_HREFS.includes(href), `main hides ${href}`);
}
assert(isAdminToolPath("/manage/caddy-search"), "caddy-search is a tool");
assert(isAdminToolPath("/manage/assignments/preview"), "preview is a tool");
assert(!isAdminToolPath("/manage/assignments"), "자동배치 is not a tool");
assert(!isAdminToolPath("/manage/caddies"), "캐디 관리 is not a tool");
assert(!isAdminToolPath("/manage"), "dashboard is not a tool");

console.log("== active highlight ==");
assert(activeAdminMainHref("/manage") === "/manage", "dashboard active");
assert(
  activeAdminMainHref("/manage/availability") === "/manage",
  "availability route highlights 대시보드"
);
assert(
  ADMIN_MAIN_NAV.every((i) => i.href !== "/manage/availability"),
  "가용표 is not a main nav item"
);
assert(
  activeAdminMainHref("/manage/assignments") === "/manage/assignments",
  "자동배치 active"
);
assert(
  activeAdminMainHref("/manage/assignments/preview") === "/manage/tools",
  "preview highlights 관리도구"
);
assert(activeAdminMainHref("/manage/users") === "/manage/tools", "계정 연결 → 관리도구");
assert(
  activeAdminMainHref("/manage/tools") === "/manage/tools",
  "hub highlights 관리도구"
);
assert(activeAdminMainHref("/board") === "/board", "배치표 active");

console.log("== staff account gate ==");
const adminTools = manageToolItems(true).map((i) => i.href);
const staffTools = manageToolItems(false).map((i) => i.href);
assert(adminTools.includes("/manage/staff-accounts"), "account manager sees 직원 계정");
assert(!staffTools.includes("/manage/staff-accounts"), "staff admin hides 직원 계정");
assert(staffTools.includes("/manage/users"), "staff still sees 계정 연결");
assert(manageNavItems(false).every((i) => i.href !== "/manage/staff-accounts"), "staff main no 직원 계정");
assert(manageNavItems(true).every((i) => i.href !== "/manage/staff-accounts"), "super main no 직원 계정");

console.log("== tool groups (default / primary) ==");
const allTools = manageToolItems(true);
const primary = primaryAdminToolItems(allTools);
const legacy = legacyAdminToolItems(allTools);
const grouped = groupAdminToolItems(primary);
assert(grouped.map((g) => g.label).join(",") === "운영 보조,알림,계정 / 시스템", "group labels");
assert(
  grouped[0].items.map((i) => i.label).join(",") === "캐디 검색",
  "ops tools default"
);
assert(
  grouped[1].items.map((i) => i.label).join(",") === "알림 설정,알림톡",
  "notify tools default"
);
assert(
  grouped[2].items.map((i) => i.label).join(",") ===
    "계정 연결,개인정보 요청,직원 계정",
  "account tools"
);
assert(
  grouped.every((g) => g.items.every((i) => !i.legacy)),
  "default groups exclude legacy"
);
assert(
  !primary.some((i) =>
    [
      "/manage/assignments/preview",
      "/manage/reservations",
      "/manage/push-test",
    ].includes(i.href)
  ),
  "default catalog hides preview/reservations/push-test"
);
assert(
  legacy.map((i) => i.href).join(",") ===
    [
      "/manage/assignments/preview",
      "/manage/reservations",
      "/manage/push-test",
    ].join(","),
  "legacy catalog order"
);
assert(
  legacy.every((i) => i.legacy === true),
  "legacy items flagged"
);
assert(
  ADMIN_TOOL_ITEMS.some(
    (i) =>
      i.href === "/manage/push-test" &&
      i.description.includes("Native/PWA Push") &&
      i.legacy === true
  ),
  "push-test copy + legacy"
);
assert(
  ADMIN_TOOL_ITEMS.some(
    (i) =>
      i.href === "/manage/reservations" &&
      i.description.includes("DB 저장 없음") &&
      i.legacy === true
  ),
  "reservations copy + legacy"
);
assert(
  ADMIN_TOOL_ITEMS.some(
    (i) =>
      i.href === "/manage/alimtalk" &&
      i.description.includes("실제 발송 없음") &&
      !i.legacy
  ),
  "알림톡 stays primary and marks preview"
);
assert(
  allTools.some((i) => i.href === "/manage/assignments/preview"),
  "manageToolItems still includes preview"
);

console.log("== routes still exist (no delete / no redirect) ==");
const routes = [
  "src/app/manage/caddy-search/page.tsx",
  "src/app/manage/assignments/preview/page.tsx",
  "src/app/manage/reservations/page.tsx",
  "src/app/manage/alimtalk/page.tsx",
  "src/app/manage/notifications/page.tsx",
  "src/app/manage/push-test/page.tsx",
  "src/app/manage/users/page.tsx",
  "src/app/manage/privacy-requests/page.tsx",
  "src/app/manage/staff-accounts/page.tsx",
  "src/app/manage/tools/page.tsx",
  "src/app/manage/availability/page.tsx",
];
for (const file of routes) {
  assert(fs.existsSync(path.resolve(file)), `kept ${file}`);
}
const toolsPage = read("src/app/manage/tools/page.tsx");
assert(toolsPage.includes("관리도구"), "hub title");
assert(toolsPage.includes("manageToolItems"), "hub uses tool catalog");
assert(toolsPage.includes("primaryAdminToolItems"), "hub default uses primary tools");
assert(toolsPage.includes("legacyAdminToolItems"), "hub lists legacy separately");
assert(toolsPage.includes("<details"), "hub uses collapsed details");
assert(toolsPage.includes(ADMIN_LEGACY_TOOLS_SUMMARY), "hub summary copy");
assert(toolsPage.includes(ADMIN_LEGACY_TOOL_NOTE), "legacy rows mark diagnostic");
assert(toolsPage.includes("isAccountManagerAuth"), "hub respects staff gate");
assert(!toolsPage.includes("redirect("), "hub does not redirect");
const shell = read("src/components/manage/ManageShell.tsx");
assert(shell.includes('href: "/manage/caddies"'), "bottom 캐디 kept");
assert(shell.includes('href: "#menu"'), "bottom 메뉴 kept");
assert(shell.includes("/manage/tools"), "prefetch/hub path");
assert(!shell.includes('label: "캐디 검색"'), "shell no longer lists 캐디 검색");
assert(!shell.includes("/manage/availability"), "shell no longer prefetches 가용표");
const avPage = read("src/app/manage/availability/page.tsx");
assert(avPage.includes("ManageAvailabilityPanel"), "availability route still renders panel");
assert(!avPage.includes("redirect("), "availability route does not redirect");
const mw = read("src/middleware.ts");
assert(mw.includes('pathname.startsWith("/manage")'), "middleware manage gate unchanged");
assert(mw.includes("/manage/staff-accounts"), "middleware staff-accounts gate kept");

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
