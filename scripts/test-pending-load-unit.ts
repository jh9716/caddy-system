/**
 * P0 Loading UX helpers + 화면 배선. DB 없음.
 *   npm run test:pending-load-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  boardPendingCopy,
  calendarPlaceholderDates,
  dashboardUpdatingCopy,
  isCurrentLoadGen,
  isStaleCalendarMonth,
  isStaleDashboardDate,
  isStalePublishedBoard,
  shouldKeepPreviousBoard,
  shouldShowDashboardZeroCount,
} from "../src/lib/pendingLoad";

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

section("stale gen");
{
  assert(isCurrentLoadGen(2, 2), "same gen applies");
  assert(!isCurrentLoadGen(1, 2), "older gen ignored");
}

section("board pending copy");
{
  assert(boardPendingCopy({ loading: false, selectedDate: "2026-10-02", publishedDate: "2026-10-01" }) === null, "idle no copy");
  assert(
    boardPendingCopy({ loading: true, selectedDate: "2026-10-02", publishedDate: "2026-10-01" }) ===
      "이전 배치표 표시 중 · 2026-10-02 불러오는 중",
    "keep previous labeled"
  );
  assert(
    boardPendingCopy({
      loading: false,
      error: true,
      selectedDate: "2026-10-02",
      publishedDate: "2026-10-01",
    }) === "이전 배치표 표시 중 · 2026-10-02 불러오기 실패",
    "error keeps previous labeled"
  );
  assert(
    boardPendingCopy({ loading: true, selectedDate: "2026-10-01", publishedDate: null }) ===
      "업데이트 중…",
    "initial pending"
  );
  assert(isStalePublishedBoard("2026-10-01", "2026-10-02"), "published date mismatch is stale");
  assert(!isStalePublishedBoard("2026-10-02", "2026-10-02"), "matching date is current");
  assert(shouldKeepPreviousBoard({ date: "2026-10-01" }), "keep when published exists");
  assert(!shouldKeepPreviousBoard(null), "no keep when empty");
}

section("calendar month");
{
  assert(isStaleCalendarMonth("2026-10", "2026-11"), "other month is stale");
  assert(isStaleCalendarMonth(null, "2026-11"), "null data is stale");
  assert(!isStaleCalendarMonth("2026-11", "2026-11"), "same month is fresh");
  const days = calendarPlaceholderDates("2026-11");
  assert(days[0] === "2026-11-01" && days[days.length - 1] === "2026-11-30", "placeholder 11월");
  assert(!days.some((d) => d.startsWith("2026-10")), "placeholder not previous month");
  const dec = calendarPlaceholderDates("2026-12");
  assert(dec.length === 31 && dec[30] === "2026-12-31", "placeholder 12월 31일");
}

section("dashboard zero");
{
  assert(!shouldShowDashboardZeroCount(false), "initial hides 0");
  assert(shouldShowDashboardZeroCount(true), "loaded may show 0");
  assert(isStaleDashboardDate("2026-10-01", "2026-09-30"), "dash date mismatch");
  assert(!isStaleDashboardDate("2026-10-01", "2026-10-01"), "dash date match");
  assert(
    dashboardUpdatingCopy({ loading: true, hasData: true, staleDate: true, error: false }) ===
      "업데이트 중…",
    "date refresh copy"
  );
  assert(
    dashboardUpdatingCopy({ loading: false, hasData: true, staleDate: true, error: true }) ===
      "이전 날짜 표시 중 · 불러오기 실패",
    "date error keeps previous labeled"
  );
  assert(
    dashboardUpdatingCopy({ loading: false, hasData: false, staleDate: false, error: true }) ===
      null,
    "initial error has no updating copy"
  );
}

section("board wiring");
{
  const page = read("src/app/board/page.tsx");
  assert(page.includes("loadGen"), "board loadGen");
  assert(page.includes("isCurrentLoadGen"), "board stale guard");
  assert(page.includes("boardPendingCopy"), "board pending copy");
  assert(page.includes("pub-board-pending"), "keep previous dim");
  assert(!/\{loading \? <p className="pub-msg">불러오는 중/.test(page), "no wipe 불러오는 중");
  assert(page.includes("{published ?"), "board stays while loading");
  assert(page.includes("const [loading, setLoading] = useState(true)"), "board starts pending");
  assert(page.includes("아직 확정된 배치표가 없습니다."), "unpublished empty after load");
  assert(page.includes('setShift("1부")'), "shift buttons remain");
  assert(!page.includes("/api/assignments/published") || page.includes("setShift"), "no extra published fetch for shift");
  assert(page.includes("staleBoard ? null : <BoardComments"), "stale board comments off");
  assert(page.includes("exportDraft && !staleBoard"), "stale board export off");
  assert(page.includes("isCurrentLoadGen(gen, loadGen.current)"), "success/error/finally gen guard");
  assert((page.match(/if \(!isCurrentLoadGen\(gen, loadGen\.current\)\) return;/g) || []).length >= 3, "stale success and error ignored");
}

section("off-request wiring");
{
  const client = read("src/app/off-requests/OffRequestCalendarClient.tsx");
  assert(client.includes("loadGen"), "member loadGen");
  assert(client.includes("isStaleCalendarMonth"), "stale month guard");
  assert(client.includes("calendarPlaceholderDates"), "new month placeholder grid");
  assert(client.includes("is-pending"), "day placeholders");
  assert(!client.includes('불러오는 중…'), "no standalone 불러오는 중");
  assert(client.includes("이 달 현황 불러오는 중"), "month pending copy");
  assert(client.includes("offRequestWindowHint"), "DRAFT/OPEN/ADJUSTING hint kept");
  assert(client.includes("staleMonth ? null : data?.window"), "stale window not mixed");
  assert((client.match(/if \(!isCurrentLoadGen\(gen, loadGen\.current\)\) return;/g) || []).length >= 3, "stale calendar success/error ignored");
}

section("manage dashboard wiring");
{
  const ui = read("src/components/manage/AdminOpsDashboard.tsx");
  assert(ui.includes("AdminOpsTeamBoardSkeleton"), "team skeleton");
  assert(ui.includes("shouldShowDashboardZeroCount"), "hides 0 until data");
  assert(ui.includes("vh-skel-kpi"), "KPI placeholder");
  assert(ui.includes("dashboardUpdatingCopy"), "date refresh keeps data + updating");
  assert(ui.includes("updatingCopy"), "renders updating copy");
  assert(ui.includes("loadGen"), "dashboard stale guard");
  assert(!ui.includes('불러오는 중…'), "no first-load 불러오는 중 wipe");
  assert(ui.includes("data ?") && ui.includes("AdminOpsDutyBoard groups={data.opsDuties}"), "initial error no duty 0");
  assert(!/setData\(null\)/.test(ui), "error keeps previous data");
}

section("route loading");
{
  const notice = read("src/app/notice/loading.tsx");
  const reports = read("src/app/course-reports/loading.tsx");
  assert(notice.includes("RoutePendingSkeleton"), "notice loading");
  assert(reports.includes("RoutePendingSkeleton"), "course-reports loading");
  assert(!fs.existsSync(path.resolve("src/app/manage/loading.tsx")), "no manage/loading flash");
  assert(!fs.existsSync(path.resolve("src/app/board/loading.tsx")), "no board route wipe");
  assert(!fs.existsSync(path.resolve("src/app/off-requests/loading.tsx")), "no off-request route wipe");
  const css = read("src/app/globals.css");
  assert(css.includes(".vh-skel"), "shared skeleton");
  assert(css.includes("prefers-reduced-motion"), "reduced motion");
  assert(css.includes("pointer-events: none"), "stale board not clickable");
  const noticeLayout = read("src/app/notice/layout.tsx");
  const reportLayout = read("src/app/course-reports/layout.tsx");
  assert(noticeLayout.includes("redirect(\"/login?callbackUrl=/notice\")"), "notice auth still in layout");
  assert(reportLayout.includes("redirect(\"/login?callbackUrl=/course-reports\")"), "course-report auth still in layout");
  assert(fs.existsSync(path.resolve("src/app/notice/[id]/page.tsx")), "notice child uses parent loading only");
  assert(fs.existsSync(path.resolve("src/app/course-reports/[id]/page.tsx")), "course-report child uses parent loading only");
}

if (failed > 0) {
  console.error(`\npending-load failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\npending-load passed: ${passed}`);
