/**
 * /caddy dashboard V2 layout lock. Source-scan only. No DB / API.
 * 실행: npm run test:caddy-dashboard-v2-unit
 */
import fs from "node:fs";
import path from "node:path";

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
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

const page = read("src/app/caddy/page.tsx");
const css = read("src/app/globals.css");

console.log("== title / hierarchy ==");
assert(!page.includes("캐디 대시보드 (보기 전용)"), "old view-only title removed");
assert(page.includes("내 대시보드"), "title 내 대시보드");
assert(page.includes("caddy-home-today"), "today card");
assert(page.includes("개인 상태 정보 없음"), "no invented personal duty");
assert(!page.includes("정상 근무"), "does not infer 정상 근무");

console.log("== today counts compact ==");
assert(page.includes('label="휴무"'), "휴무");
assert(page.includes('label="병가"'), "병가");
assert(page.includes('label="장기병가"'), "장기병가");
assert(page.includes('label="당번"'), "당번");
assert(page.includes('label="마샬"'), "마샬");
assert(css.includes("caddy-home-stats"), "compact stats grid");
assert(css.includes("grid-template-columns: repeat(5, minmax(0, 1fr))"), "5-col compact grid");
assert(css.includes(".caddy-home-stat-label"), "stat label class");
assert(/\.caddy-home-stat-label[\s\S]*white-space:\s*nowrap/.test(css), "장기병가 label nowrap");
assert(css.includes("--caddy-home-muted: #6c766e"), "scoped muted for AA contrast");
assert(!/^\s*--vh-muted:\s*#6c766e/m.test(css), "does not rewrite global --vh-muted");

console.log("== notices up, 3-4, badges ==");
assert(page.includes("NOTICE_PREVIEW"), "notice preview cap");
assert(page.includes("slice(0, NOTICE_PREVIEW)"), "slice latest notices");
assert(/const NOTICE_PREVIEW = 4/.test(page), "preview 4");
assert(page.includes("전체보기"), "전체보기");
assert(page.includes('href="/notice"'), "notice list link");
assert(page.includes("caddy-home-badge"), "badge classes");
assert(page.includes("formatKstDisplay"), "KST display");
assert(!page.includes("toLocaleString("), "no toLocaleString");
assert(css.includes("text-overflow: ellipsis"), "title truncate");

console.log("== schedule CTA / no duplicate nav CTAs ==");
assert(page.includes("월간 휴무 신청"), "keeps 월간 휴무 신청");
assert(page.includes('href="/off-requests"'), "off-request entry");
assert(/href="\/board"/.test(page), "small /board shortcut remains");
assert(!page.includes("공용 배치표 보기"), "no large 공용 배치표 CTA");
assert(!page.includes("코스 제보 보기"), "no large 코스 제보 CTA");

console.log("== push moved, default card kept ==");
assert(page.includes("<DevicePushSettings />"), "default DevicePushSettings");
assert(page.includes("caddy-home-push"), "push at settings row wrapper");
assert(page.indexOf("caddy-home-today") < page.indexOf("caddy-home-push"), "today before push");
assert(page.indexOf("최근 공지") < page.indexOf("내 일정"), "notices above schedule");
assert(page.includes("PwaInstallCard"), "PWA card still mounted");
assert(!page.includes("requestPermission"), "page does not request permission");

console.log("== reuse existing data / no new API ==");
assert(page.includes("/api/check-role"), "check-role");
assert(page.includes("/api/caddy-link-requests/mine"), "mine");
assert(page.includes("/api/summary"), "summary");
assert(page.includes("CLIENT_RESOURCE.CADDY_SUMMARY"), "summary cache");
assert(page.includes("CLIENT_RESOURCE.CADDY_MINE"), "mine cache");
assert(page.includes("peekSafeCaddySummary"), "first paint peek");
assert(page.includes("resolveCaddyPageGate"), "role gate");
assert(page.includes("!summary && (loading || !allowed)"), "cached first paint");
assert(!page.includes("/api/off-requests"), "no extra off-requests fetch");
assert(!/fetch\(['"]\/api\/(?!check-role|caddy-link-requests\/mine|summary)/.test(page), "no new page fetches");

if (failed > 0) {
  console.error(`\ncaddy-dashboard-v2 tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\ncaddy-dashboard-v2 tests passed: ${passed}`);
