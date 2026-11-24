/**
 * 공지 게시기간 (계속 게시 / 오늘만 / 기간 지정 / 예약 게시) — 순수 로직 + 정적 검사.
 * No DB, no network. KST 계산은 기기 시간대와 무관해야 한다 (TZ를 바꿔 실행해도 통과).
 * 실행: npm run test:notice-publish-window-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  NOTICE_PUBLISH_MODES,
  NOTICE_PUBLISH_MODE_LABELS,
  NOTICE_PUBLISH_MSG_END_BEFORE_START,
  NOTICE_PUBLISH_MSG_START_REQUIRED,
  computeNoticePublishWindow,
  initialNoticePublishForm,
  isKstEndOfDay,
  isKstStartOfDay,
  kstEndOfDay,
  kstStartOfDay,
  noticePublishSummary,
  noticeRangeDefaultEndYmd,
  noticeScheduledDefaultLocal,
  noticeTodayWindow,
} from "../src/lib/noticePublishWindow";
import {
  NoticeValidationError,
  assertNoticePublishOrder,
  isNoticeInPublishWindow,
  parseNoticePublishWindow,
} from "../src/lib/noticeTarget";

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
function section(t: string) {
  console.log("\n==", t, "==");
}
function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}
function throwsValidation(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof NoticeValidationError;
  }
}

// 2026-11-25 10:00 KST = 01:00Z
const NOW = new Date("2026-11-25T01:00:00.000Z");
// 2026-11-25 23:30 KST = 14:30Z (KST 밤, UTC 낮)
const LATE = new Date("2026-11-25T14:30:00.000Z");
// 2026-11-25 00:30 KST = 2026-11-24 15:30Z (UTC로는 전날)
const EARLY = new Date("2026-11-24T15:30:00.000Z");

const base = {
  rangeStartYmd: "2026-11-25",
  rangeEndYmd: "2026-12-02",
  scheduledStartLocal: "2026-11-26T09:00",
  scheduledEndYmd: "",
};

section("modes and labels");
assert(
  JSON.stringify(NOTICE_PUBLISH_MODES) === JSON.stringify(["always", "today", "range", "scheduled"]),
  "4 modes in order"
);
assert(
  NOTICE_PUBLISH_MODE_LABELS.always === "계속 게시" &&
    NOTICE_PUBLISH_MODE_LABELS.today === "오늘만" &&
    NOTICE_PUBLISH_MODE_LABELS.range === "기간 지정" &&
    NOTICE_PUBLISH_MODE_LABELS.scheduled === "예약 게시",
  "Korean labels"
);

section("KST day boundaries (device timezone independent)");
assert(kstStartOfDay("2026-11-25").toISOString() === "2026-11-24T15:00:00.000Z", "KST 00:00");
assert(kstEndOfDay("2026-11-25").toISOString() === "2026-11-25T14:59:59.999Z", "KST 23:59:59.999");
assert(isKstStartOfDay(kstStartOfDay("2026-01-01")), "isKstStartOfDay");
assert(isKstEndOfDay(kstEndOfDay("2026-12-31")), "isKstEndOfDay");
assert(!isKstEndOfDay(new Date("2026-11-25T14:59:00.000Z")), "23:59:00 is not end-of-day");
assert(
  JSON.stringify(noticeTodayWindow(EARLY)) === JSON.stringify(noticeTodayWindow(LATE)),
  "today window same at KST 00:30 and 23:30"
);
assert(
  noticeTodayWindow(EARLY).publishStartAt!.toISOString() === "2026-11-24T15:00:00.000Z",
  "KST 00:30 (UTC previous day) still uses KST today"
);

section("defaults");
const fresh = initialNoticePublishForm(null, null, NOW);
assert(fresh.mode === "always", "default mode 계속 게시");
assert(fresh.rangeStartYmd === "2026-11-25", "range start default today (KST)");
assert(fresh.rangeEndYmd === "2026-12-02", "range end default start + 7 days");
assert(noticeRangeDefaultEndYmd("2026-12-28") === "2027-01-04", "+7 days across year");
assert(fresh.scheduledStartLocal === "2026-11-26T09:00", "scheduled default tomorrow 09:00 KST");
assert(noticeScheduledDefaultLocal(LATE) === "2026-11-26T09:00", "late-night KST still tomorrow");
assert(fresh.scheduledEndYmd === "", "scheduled end optional/empty");

section("compute");
{
  const r = computeNoticePublishWindow({ ...base, mode: "always" }, NOW);
  assert(r.ok && r.window.publishStartAt === null && r.window.publishEndAt === null, "always → null/null");
}
{
  const r = computeNoticePublishWindow({ ...base, mode: "today" }, NOW);
  assert(
    r.ok &&
      r.window.publishStartAt!.toISOString() === "2026-11-24T15:00:00.000Z" &&
      r.window.publishEndAt!.toISOString() === "2026-11-25T14:59:59.999Z",
    "today → KST 00:00 ~ 23:59:59.999"
  );
}
{
  const r = computeNoticePublishWindow({ ...base, mode: "range" }, NOW);
  assert(
    r.ok &&
      r.window.publishStartAt!.toISOString() === "2026-11-24T15:00:00.000Z" &&
      r.window.publishEndAt!.toISOString() === "2026-12-02T14:59:59.999Z",
    "range end date inclusive to end of day"
  );
  const same = computeNoticePublishWindow(
    { ...base, mode: "range", rangeStartYmd: "2026-11-30", rangeEndYmd: "2026-11-30" },
    NOW
  );
  assert(same.ok, "range single day allowed");
  const bad = computeNoticePublishWindow(
    { ...base, mode: "range", rangeStartYmd: "2026-12-03", rangeEndYmd: "2026-12-02" },
    NOW
  );
  assert(!bad.ok && bad.message === NOTICE_PUBLISH_MSG_END_BEFORE_START, "range end < start blocked");
  const empty = computeNoticePublishWindow({ ...base, mode: "range", rangeEndYmd: "" }, NOW);
  assert(!empty.ok, "range empty date blocked");
}
{
  const r = computeNoticePublishWindow({ ...base, mode: "scheduled" }, NOW);
  assert(
    r.ok &&
      r.window.publishStartAt!.toISOString() === "2026-11-26T00:00:00.000Z" &&
      r.window.publishEndAt === null,
    "scheduled 09:00 KST, no end"
  );
  const withEnd = computeNoticePublishWindow(
    { ...base, mode: "scheduled", scheduledEndYmd: "2026-11-26" },
    NOW
  );
  assert(
    withEnd.ok && withEnd.window.publishEndAt!.toISOString() === "2026-11-26T14:59:59.999Z",
    "scheduled end same day inclusive"
  );
  const badEnd = computeNoticePublishWindow(
    { ...base, mode: "scheduled", scheduledEndYmd: "2026-11-25" },
    NOW
  );
  assert(!badEnd.ok && badEnd.message === NOTICE_PUBLISH_MSG_END_BEFORE_START, "scheduled end before start blocked");
  const noStart = computeNoticePublishWindow({ ...base, mode: "scheduled", scheduledStartLocal: "" }, NOW);
  assert(!noStart.ok && noStart.message === NOTICE_PUBLISH_MSG_START_REQUIRED, "scheduled start required");
}

section("edit: infer mode from saved values, legacy preserved");
{
  const today = noticeTodayWindow(NOW);
  assert(initialNoticePublishForm(today.publishStartAt, today.publishEndAt, NOW).mode === "today", "today window → 오늘만");
  const r = initialNoticePublishForm(
    kstStartOfDay("2026-11-20").toISOString(),
    kstEndOfDay("2026-11-27").toISOString(),
    NOW
  );
  assert(r.mode === "range" && r.rangeStartYmd === "2026-11-20" && r.rangeEndYmd === "2026-11-27", "range restored");
  const past = initialNoticePublishForm(today.publishStartAt, today.publishEndAt, new Date("2026-11-26T01:00:00.000Z"));
  assert(past.mode === "range" && past.rangeStartYmd === "2026-11-25", "yesterday's 오늘만 shows as 기간 지정");
  const sch = initialNoticePublishForm("2026-11-26T00:00:00.000Z", null, NOW);
  assert(sch.mode === "scheduled" && sch.scheduledStartLocal === "2026-11-26T09:00", "scheduled restored (KST)");
  const legacyEnd = initialNoticePublishForm(null, "2026-11-30T14:59:00.000Z", NOW);
  assert(legacyEnd.mode === "legacy", "old end 23:59:00 (datetime-local) → legacy");
  const legacyRange = initialNoticePublishForm("2026-11-20T06:00:00.000Z", "2026-11-30T09:00:00.000Z", NOW);
  assert(legacyRange.mode === "legacy", "arbitrary times → legacy");
  const kept = computeNoticePublishWindow(legacyRange, NOW);
  assert(
    kept.ok &&
      kept.window.publishStartAt!.toISOString() === "2026-11-20T06:00:00.000Z" &&
      kept.window.publishEndAt!.toISOString() === "2026-11-30T09:00:00.000Z",
    "legacy compute returns saved values unchanged"
  );
  assert(
    noticePublishSummary(legacyRange.legacy!, "legacy").startsWith("기존 설정 그대로 유지"),
    "legacy summary label"
  );
  const secs = initialNoticePublishForm("2026-11-26T00:00:30.000Z", null, NOW);
  assert(secs.mode === "legacy", "start with seconds → legacy (minute input would change it)");
}

section("summary text");
{
  const r = computeNoticePublishWindow({ ...base, mode: "range" }, NOW);
  assert(r.ok && noticePublishSummary(r.window, "range").includes("11월 25일 ~ 12월 2일"), "range summary");
  const t = computeNoticePublishWindow({ ...base, mode: "today" }, NOW);
  assert(t.ok && noticePublishSummary(t.window, "today") === "오늘(11월 25일) 하루만 보입니다.", "today summary");
  const s = computeNoticePublishWindow({ ...base, mode: "scheduled" }, NOW);
  assert(s.ok && noticePublishSummary(s.window, "scheduled").startsWith("11월 26일 09:00부터"), "scheduled summary");
}

section("server visibility rule unchanged (inclusive end)");
{
  const w = noticeTodayWindow(NOW);
  assert(isNoticeInPublishWindow(w, new Date("2026-11-25T14:59:59.999Z")), "visible at KST 23:59:59.999");
  assert(!isNoticeInPublishWindow(w, new Date("2026-11-25T15:00:00.000Z")), "hidden at next-day 00:00 KST");
  assert(isNoticeInPublishWindow({ publishStartAt: null, publishEndAt: null }, NOW), "always visible");
}

section("server validation");
assert(
  throwsValidation(() =>
    parseNoticePublishWindow({ publishStartAt: "2026-12-02T00:00:00Z", publishEndAt: "2026-12-01T00:00:00Z" })
  ),
  "POST/PATCH body start > end rejected"
);
assert(
  !throwsValidation(() => parseNoticePublishWindow({ publishStartAt: null, publishEndAt: null })),
  "both null ok"
);
assert(
  throwsValidation(() => assertNoticePublishOrder(new Date("2026-12-02T00:00:00Z"), new Date("2026-12-01T00:00:00Z"))),
  "assertNoticePublishOrder start > end"
);
assert(!throwsValidation(() => assertNoticePublishOrder(null, new Date())), "one-sided ok");
{
  const route = read("src/app/api/notice/[id]/route.ts");
  assert(
    route.includes("assertNoticePublishOrder(") &&
      route.includes("parsed.publishStartAt !== undefined ? parsed.publishStartAt : existing.publishStartAt") &&
      route.includes("parsed.publishEndAt !== undefined ? parsed.publishEndAt : existing.publishEndAt"),
    "PATCH compares a one-sided change with the saved value"
  );
}

section("form wiring (static)");
{
  const form = read("src/app/notice/new/ui/NewNoticeForm.tsx");
  const fields = read("src/components/notice/NoticePublishWindowFields.tsx");
  assert(form.includes("<NoticePublishWindowFields"), "form uses the new fields component");
  assert(!form.includes('type="datetime-local"'), "form no longer has the two raw datetime inputs");
  assert(form.includes("const sendPublishWindow = !isEdit || publishTouched"), "edit sends period only when touched");
  assert(
    form.includes("...(sendPublishWindow && publishResult.ok"),
    "untouched edit omits publishStartAt/publishEndAt from PATCH"
  );
  assert(form.includes("NOTICE_SCHEDULED_PUSH_HINT"), "scheduled push hint kept");
  assert(form.includes("isFutureNoticeStart(effectivePublishWindow"), "scheduled detection uses KST window");
  assert(!form.includes("new Date(publishStartAt)"), "no device-timezone parsing of datetime-local");
  assert(fields.includes('role="radiogroup"') && fields.includes('role="radio"'), "segment buttons accessible");
  assert(fields.includes("value.mode === 'range'") && fields.includes("value.mode === 'scheduled'"), "inputs only for range/scheduled");
  assert(!fields.includes("빠른") && !fields.includes("지우기"), "no quick-range / clear buttons");
}

section("scope guards");
{
  const schema = read("prisma/schema.prisma");
  assert(schema.includes("publishStartAt DateTime?") && schema.includes("publishEndAt   DateTime?"), "schema fields unchanged");
  const detail = read("src/app/notice/[id]/page.tsx");
  assert(!detail.includes("기한 없음"), "detail page has no 기한 없음 label");
  const list = read("src/app/notice/page.tsx");
  assert(!list.includes("notice-publish-filters"), "no admin list publish filter");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
