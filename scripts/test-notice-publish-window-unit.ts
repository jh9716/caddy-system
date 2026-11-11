/**
 * Notice publish window UI helpers + half-open visibility.
 * No DB write. 실행: npm run test:notice-publish-window-unit
 */
import fs from "node:fs";
import path from "path";
import {
  formatKstDateTimeLocal,
  kstStartOfDay,
  parseKstDateTimeLocal,
} from "../src/lib/kstDate";
import {
  adminNoticePublishWhere,
  isNoticeInPublishWindow,
  visibleNoticeWhere,
} from "../src/lib/noticeTarget";
import {
  applyNoticePublishMode,
  inferNoticePublishMode,
  kstExclusiveEndOfDay,
  noticeDateOnlyWindow,
  noticePublishStatus,
  noticeQuickRangeWindow,
  noticeScheduledDefaultWindow,
  noticeTodayOnlyWindow,
  parseNoticePublishFilter,
  parseNoticePublishInstant,
  serializeNoticeDatetimeLocal,
  startIsAfterEnd,
  toNoticeDatetimeLocalValue,
} from "../src/lib/noticePublishWindow";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

const NOW = new Date("2026-11-11T12:00:00+09:00");

section("KST round-trip does not rewrite stored times");
{
  const original = "2026-11-11T09:37:00.000Z";
  const local = toNoticeDatetimeLocalValue(original);
  assert(local === "2026-11-11T18:37", "ISO UTC → KST datetime-local");
  assert(
    serializeNoticeDatetimeLocal(local) === original,
    "KST datetime-local → same UTC instant"
  );
  const midnight = "2026-11-11T00:00";
  assert(
    formatKstDateTimeLocal(parseKstDateTimeLocal(midnight)) === midnight,
    "00:00 KST round-trips"
  );
}

section("date-only exclusive next-day 00:00");
{
  const win = noticeDateOnlyWindow("2026-11-11", "2026-11-11");
  assert(
    win.publishStartAt?.toISOString() === "2026-11-10T15:00:00.000Z",
    "today start is KST 00:00"
  );
  assert(
    win.publishEndAt?.toISOString() === "2026-11-11T15:00:00.000Z",
    "today exclusive end is tomorrow 00:00 KST"
  );
  const beforeEnd = new Date("2026-11-11T23:59:59.999+09:00");
  const atEnd = new Date("2026-11-12T00:00:00+09:00");
  const afterEnd = new Date("2026-11-12T00:00:00.001+09:00");
  const atStart = new Date("2026-11-11T00:00:00+09:00");
  const beforeStart = new Date("2026-11-10T23:59:59.999+09:00");
  assert(isNoticeInPublishWindow(win, beforeEnd) === true, "visible at 23:59:59.999 KST");
  assert(isNoticeInPublishWindow(win, atEnd) === false, "hidden at next-day 00:00 KST");
  assert(isNoticeInPublishWindow(win, afterEnd) === false, "hidden after exclusive end");
  assert(isNoticeInPublishWindow(win, atStart) === true, "visible at start 00:00 KST");
  assert(isNoticeInPublishWindow(win, beforeStart) === false, "hidden before start");
  assert(noticePublishStatus(win, beforeEnd) === "live", "status live before exclusive end");
  assert(noticePublishStatus(win, atEnd) === "ended", "status ended at exclusive end");
  assert(noticePublishStatus(win, beforeStart) === "scheduled", "status scheduled before start");
  assert(
    kstExclusiveEndOfDay("2026-11-11").getTime() === kstStartOfDay("2026-11-12").getTime(),
    "exclusive end helper is next day 00:00"
  );
}

section("null window stays live");
{
  const open = { publishStartAt: null, publishEndAt: null };
  assert(isNoticeInPublishWindow(open, NOW) === true, "null/null visible");
  assert(noticePublishStatus(open, NOW) === "live", "null/null live");
  assert(inferNoticePublishMode(open, NOW) === "always", "null/null infers 계속 게시");
}

section("quick ranges");
{
  const today = noticeQuickRangeWindow("today", NOW);
  const three = noticeQuickRangeWindow("3d", NOW);
  const seven = noticeQuickRangeWindow("7d", NOW);
  const month = noticeQuickRangeWindow("month", NOW);
  assert(
    today.publishEndAt?.toISOString() === "2026-11-11T15:00:00.000Z",
    "오늘 빠른 선택 exclusive tomorrow"
  );
  assert(
    three.publishEndAt?.toISOString() === "2026-11-13T15:00:00.000Z",
    "3일 = 오늘부터 3달력일, exclusive 11/14 00:00"
  );
  assert(
    seven.publishEndAt?.toISOString() === "2026-11-17T15:00:00.000Z",
    "7일 exclusive 11/18 00:00"
  );
  assert(
    month.publishStartAt?.toISOString() === "2026-10-31T15:00:00.000Z",
    "이번 달 start Nov 1 00:00 KST"
  );
  assert(
    month.publishEndAt?.toISOString() === "2026-11-30T15:00:00.000Z",
    "이번 달 exclusive Dec 1 00:00 KST"
  );
}

section("mode apply / infer preserves custom times");
{
  const custom = {
    publishStartAt: parseKstDateTimeLocal("2026-11-11T09:00"),
    publishEndAt: parseKstDateTimeLocal("2026-11-11T18:00"),
  };
  assert(inferNoticePublishMode(custom, NOW) === "range", "custom times stay 기간 지정");
  const kept = applyNoticePublishMode("range", custom, NOW);
  assert(
    kept.publishStartAt?.toISOString() === custom.publishStartAt.toISOString() &&
      kept.publishEndAt?.toISOString() === custom.publishEndAt.toISOString(),
    "switching to range does not rewrite custom times"
  );
  const today = noticeTodayOnlyWindow(NOW);
  assert(inferNoticePublishMode(today, NOW) === "today", "today-only window infers 오늘만");
  const always = applyNoticePublishMode("always", custom, NOW);
  assert(!always.publishStartAt && !always.publishEndAt, "계속 게시 clears dates");
  const scheduled = noticeScheduledDefaultWindow(NOW);
  assert(
    scheduled.publishStartAt?.toISOString() === "2026-11-11T15:00:00.000Z",
    "예약 기본 시작은 내일 00:00 KST"
  );
  assert(scheduled.publishEndAt == null, "예약 기본 종료 없음");
  assert(inferNoticePublishMode(scheduled, NOW) === "scheduled", "future start infers 예약");
}

section("start after end blocked");
{
  const start = parseKstDateTimeLocal("2026-11-12T00:00");
  const end = parseKstDateTimeLocal("2026-11-11T00:00");
  assert(startIsAfterEnd(start, end) === true, "start > end detected");
  assert(startIsAfterEnd(end, start) === false, "valid order accepted");
}

section("admin filter vs caddy visibility");
{
  const caddy = {
    role: "caddy" as const,
    caddyId: 1,
    caddyType: "HOUSE",
    team: "1조",
  };
  const admin = {
    role: "admin" as const,
    caddyId: null,
    caddyType: null,
    team: null,
  };
  const caddyWhere = JSON.stringify(visibleNoticeWhere(caddy, NOW));
  const adminAll = JSON.stringify(adminNoticePublishWhere("all", NOW));
  const adminLive = JSON.stringify(adminNoticePublishWhere("live", NOW));
  const adminEnded = JSON.stringify(adminNoticePublishWhere("ended", NOW));
  const adminSched = JSON.stringify(adminNoticePublishWhere("scheduled", NOW));
  assert(caddyWhere.includes('"gt"'), "caddy end bound is exclusive gt");
  assert(adminAll === "{}", "admin 전체 has no publish filter");
  assert(adminLive.includes('"gt"'), "admin 게시 중 uses exclusive end");
  assert(adminEnded.includes('"lte"'), "admin 종료 is end <= now");
  assert(adminSched.includes('"gt"'), "admin 예약 is start > now");
  assert(
    JSON.stringify(visibleNoticeWhere(admin, NOW)) === "{}",
    "admin visibleNoticeWhere still unfiltered"
  );
  assert(parseNoticePublishFilter("ended") === "ended", "filter parse ended");
  assert(parseNoticePublishFilter("nope") === "all", "unknown filter → 전체");
}

section("datetime-local KST parse");
{
  assert(
    parseNoticePublishInstant("2026-11-11T00:00")?.toISOString() ===
      "2026-11-10T15:00:00.000Z",
    "datetime-local without Z is KST"
  );
}

section("source guards — no schema/push/android change");
{
  const form = read("src/app/notice/new/ui/NewNoticeForm.tsx");
  const list = read("src/app/notice/page.tsx");
  const target = read("src/lib/noticeTarget.ts");
  const schema = read("prisma/schema.prisma");
  const fields = read("src/components/notice/NoticePublishWindowFields.tsx");
  const autoPush = read("src/lib/noticeAutoPush.ts");
  assert(form.includes("serializeNoticeDatetimeLocal"), "form saves KST datetime-local");
  assert(!form.includes("toDatetimeLocalValue"), "form dropped device-TZ helper");
  assert(!form.includes("new Date(publishStartAt).toISOString()"), "form does not use device TZ ISO");
  assert(form.includes("NOTICE_PHOTO_MAX"), "photo attach kept");
  assert(form.includes("NOTICE_FILE_MAX"), "file attach kept");
  assert(form.includes("classifyNoticeClipboard"), "clipboard paste kept");
  assert(form.includes("important"), "important kept");
  assert(form.includes("pinned"), "pinned kept");
  assert(list.includes("adminNoticePublishWhere"), "admin list can filter");
  assert(list.includes("visibleNoticeWhere(viewer)"), "caddy list still window-filtered");
  assert(list.includes('auth.role === "admin"'), "publish filter is admin-only");
  assert(target.includes("publishEndAt: { gt: now }"), "server end exclusive");
  assert(target.includes("publishStartAt: { lte: now }"), "server start inclusive");
  assert(schema.includes("publishStartAt DateTime?"), "existing columns kept");
  assert(!fields.includes("cron"), "UI has no cron");
  assert(autoPush.includes("scheduled"), "auto-push still skips scheduled");
  assert(fields.includes("NOTICE_SCHEDULED_PUSH_HINT"), "manual push hint for scheduled");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
