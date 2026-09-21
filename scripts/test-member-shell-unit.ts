/**
 * Caddy/leader MemberShell vs admin ManageShell.
 * 실행: npx tsx scripts/test-member-shell-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  memberNavExposesAdminMenu,
  memberNavItems,
  shouldUseManageShellForBoard,
  shouldUseManageShellForCourseReport,
  shouldUseManageShellForNotice,
  shouldUseMemberShell,
} from "../src/lib/boardNav";
import { manageNavItems } from "../src/components/manage/ManageShell";
import { resolveCaddyPageGate } from "../src/lib/roleRouting";

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

section("role gates");
{
  assert(shouldUseMemberShell("caddy") === true, "caddy uses member shell");
  assert(shouldUseMemberShell("leader") === true, "leader uses member shell");
  assert(shouldUseMemberShell("admin") === false, "admin does not use member shell");
  assert(shouldUseMemberShell(null) === false, "guest no member shell");
  assert(shouldUseManageShellForBoard("admin") === true, "admin board ManageShell");
  assert(shouldUseManageShellForBoard("caddy") === false, "caddy board not admin shell");
  assert(shouldUseManageShellForNotice("caddy") === false, "caddy notice not admin shell");
  assert(shouldUseManageShellForCourseReport("caddy") === false, "caddy report not admin shell");
  assert(shouldUseManageShellForCourseReport("leader") === false, "leader report not admin shell");
}

section("member menus");
{
  const items = memberNavItems();
  const labels = items.map((i) => i.label);
  const hrefs = items.map((i) => i.href);
  assert(labels.join(",") === "홈,공지,제보,배치표,내 대시보드", "member menu labels");
  assert(hrefs.join(",") === "/,/notice,/course-reports,/board,/caddy", "member hrefs");
  assert(memberNavExposesAdminMenu() === false, "member nav admin menu 0");
  assert(!hrefs.some((h) => h.startsWith("/manage")), "member href no /manage");
  for (const banned of ["캐디 관리", "자동배치", "직원 계정", "계정 연결", "관리자"]) {
    assert(!labels.includes(banned), `member no ${banned}`);
  }
}

section("admin menus unchanged");
{
  const admin = manageNavItems(true).map((i) => i.href);
  const staff = manageNavItems(false).map((i) => i.href);
  assert(admin.includes("/manage/caddies"), "admin keeps 캐디 관리");
  assert(admin.includes("/manage/assignments"), "admin keeps 자동배치");
  assert(admin.includes("/manage/staff-accounts"), "account manager keeps 직원 계정");
  assert(!staff.includes("/manage/staff-accounts"), "staff admin hides 직원 계정");
  assert(admin.includes("/manage/notifications"), "admin keeps 알림 설정");
  assert(admin.includes("/course-reports"), "admin keeps 코스 제보");
  const manageShell = read("src/components/manage/ManageShell.tsx");
  assert(manageShell.includes('label: "캐디 관리"'), "ManageShell still has 캐디 관리");
  assert(manageShell.includes('href: "/manage/caddies"'), "admin bottom/nav 캐디 path");
  assert(manageShell.includes('href: "#menu"'), "admin bottom still has 메뉴 tab");
  assert(!/BOTTOM[\s\S]*course-reports/.test(manageShell), "admin bottom nav not expanded");
}

section("wiring");
{
  const root = read("src/app/layout.tsx");
  assert(root.includes("MemberShell"), "root layout wraps MemberShell");
  assert(root.includes("shouldUseMemberShell"), "root gates member shell by role");
  assert(root.includes("AppHeader"), "admin/guest still AppHeader");
  const member = read("src/components/manage/MemberShell.tsx");
  assert(member.includes("vh-bottom-tabs-5"), "member 5 equal bottom tabs");
  assert(member.includes('label: "내 대시보드"'), "member bottom 내 대시보드");
  assert(member.includes('href: "/course-reports"'), "member bottom 제보");
  assert(!member.includes("/manage/caddies"), "MemberShell no 캐디 관리 href");
  assert(!member.includes("자동배치"), "MemberShell no 자동배치");
  assert(!member.includes("직원 계정"), "MemberShell no 직원 계정");
  assert(member.includes("LogoutButton") === false, "logout not in MemberShell body (chrome foot)");
  const chrome = read("src/components/manage/AppChrome.tsx");
  assert(chrome.includes("LogoutButton"), "logout lives in shared chrome drawer/sidebar");
  assert(chrome.includes('aria-label="메뉴 열기"'), "hamburger");
  assert(chrome.includes("VERTHILL"), "central brand");
  const caddyPage = read("src/app/caddy/page.tsx");
  assert(resolveCaddyPageGate("leader").action === "enter", "leader can open 내 대시보드");
  assert(caddyPage.includes("resolveCaddyPageGate"), "caddy page uses role gate helper");
  const home = read("src/app/page.tsx");
  assert(home.includes('role === "leader"'), "home CTA sends leader to /caddy");
  const css = read("src/app/globals.css");
  assert(css.includes(".vh-bottom-tabs-5"), "5-col tab css");
  assert(css.includes(".vh-drawer-foot .vh-logout-group"), "drawer logout stacks");
  assert(css.includes("white-space: nowrap"), "drawer logout labels stay on one line");
  const logout = read("src/components/LogoutButton.tsx");
  assert(!logout.includes("inline-flex"), "LogoutButton layout is CSS-owned");
  const header = read("src/components/AppHeader.tsx");
  assert(header.includes("/manage"), "admin AppHeader 관리자 유지");
  assert(header.includes("내 대시보드"), "AppHeader still has caddy fallback link");
}

if (failed > 0) {
  console.error(`\nmember-shell tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nmember-shell tests passed: ${passed}`);
