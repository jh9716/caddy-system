/**
 * Notice datetime display uses shared Asia/Seoul formatter.
 * DB UTC values are not rewritten. No live I/O.
 * 실행: npm run test:notice-kst-display-unit
 */
import fs from "node:fs";
import path from "node:path";
import { formatCapturedAtKst, formatKstDisplay } from "../src/lib/kstDate";

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

section("shared KST formatter");
{
  const utc = "2026-09-26T06:37:00.000Z";
  const d = new Date(utc);
  assert(formatKstDisplay(utc, "ymd-hm") === "2026-09-26 15:37", "ISO UTC → KST datetime");
  assert(formatKstDisplay(d, "ymd-hm") === "2026-09-26 15:37", "Date UTC → KST datetime");
  assert(formatKstDisplay(utc, "ymd") === "2026-09-26", "date-only KST");
  assert(formatKstDisplay(utc, "md-hm") === "09-26 15:37", "admin glance KST");
  assert(formatKstDisplay(utc, "captured") === "2026.09.26 15:37", "captured style KST");
  assert(formatCapturedAtKst(utc) === "2026.09.26 15:37", "formatCapturedAtKst reuses helper");
  assert(
    formatKstDisplay("2026-09-25T23:00:00.000Z", "ymd") === "2026-09-26",
    "late UTC previous calendar day → next KST date"
  );
  assert(formatKstDisplay(null, "ymd-hm") === "", "null → empty");
  assert(formatKstDisplay("not-a-date", "ymd-hm") === "not-a-date", "invalid keeps input");
}

section("notice surfaces reuse formatKstDisplay");
{
  const files = [
    "src/app/notice/page.tsx",
    "src/app/notice/[id]/page.tsx",
    "src/components/notice/NoticePushNotifyCard.tsx",
    "src/app/manage/page.tsx",
    "src/app/caddy/page.tsx",
    "src/app/manage/DashboardClient.tsx",
  ];
  for (const rel of files) {
    const src = read(rel);
    assert(src.includes("formatKstDisplay"), `${rel} uses formatKstDisplay`);
    assert(!src.includes('dayjs('), `${rel} no dayjs(`);
    assert(!src.includes("toLocaleString("), `${rel} no toLocaleString`);
  }
  const detail = read("src/app/notice/[id]/page.tsx");
  assert(detail.includes('formatKstDisplay(notice.createdAt, "ymd-hm")'), "createdAt KST");
  assert(
    detail.includes('formatKstDisplay(notice.publishStartAt, "ymd-hm")'),
    "publishStartAt KST"
  );
  assert(
    detail.includes('formatKstDisplay(notice.publishEndAt, "ymd-hm")'),
    "publishEndAt KST"
  );
  const pushCard = read("src/components/notice/NoticePushNotifyCard.tsx");
  assert(pushCard.includes('formatKstDisplay(sentAt, "ymd-hm")'), "pushSentAt KST");
  const kst = read("src/lib/kstDate.ts");
  assert(kst.includes('timeZone: KST') || kst.includes('timeZone: "Asia/Seoul"') || kst.includes('const KST = "Asia/Seoul"'), "Asia/Seoul");
  assert(kst.includes("formatKstDisplay"), "one shared display helper");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
