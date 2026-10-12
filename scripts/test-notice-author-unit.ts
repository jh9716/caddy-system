/**
 * Notice author is a server snapshot of the logged-in writer.
 * Client author is ignored. Username is never shown. Null → 관리자.
 * 실행: npm run test:notice-author-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  NOTICE_AUTHOR_FALLBACK,
  formatNoticeAuthorDisplay,
  resolveNoticeAuthorDisplayName,
  resolveNoticeAuthorForAuth,
} from "../src/lib/noticeAuthor";
import { parseNoticeWriteBody } from "../src/lib/noticeTarget";

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

section("display fallback");
{
  assert(NOTICE_AUTHOR_FALLBACK === "관리자", "fallback copy");
  assert(formatNoticeAuthorDisplay(null) === "관리자", "null → 관리자");
  assert(formatNoticeAuthorDisplay(undefined) === "관리자", "undefined → 관리자");
  assert(formatNoticeAuthorDisplay("") === "관리자", "empty → 관리자");
  assert(formatNoticeAuthorDisplay("   ") === "관리자", "blank → 관리자");
  assert(formatNoticeAuthorDisplay("신정훈") === "신정훈", "stored name");
  assert(formatNoticeAuthorDisplay("  신정훈  ") === "신정훈", "trim stored name");
}

section("create-time name policy");
{
  assert(
    resolveNoticeAuthorDisplayName({ caddyName: "신정훈" }) === "신정훈",
    "linked Caddy.name"
  );
  assert(
    resolveNoticeAuthorDisplayName({ caddyName: "  신정훈  " }) === "신정훈",
    "trim Caddy.name"
  );
  assert(
    resolveNoticeAuthorDisplayName({ caddyName: "" }) === "관리자",
    "empty Caddy.name → 관리자"
  );
  assert(
    resolveNoticeAuthorDisplayName({ caddyName: null }) === "관리자",
    "null Caddy.name → 관리자"
  );
  assert(
    resolveNoticeAuthorDisplayName({}) === "관리자",
    "no Caddy → 관리자, not username"
  );
  const long = "가".repeat(80);
  assert(
    resolveNoticeAuthorDisplayName({ caddyName: long }).length === 64,
    "name is capped"
  );
}

async function testAuthResolver() {
  section("auth resolver");
  const calls: number[] = [];
  const db = {
    caddy: {
      async findUnique(args: { where: { id: number } }) {
        calls.push(args.where.id);
        if (args.where.id === 7) return { name: "조장김" };
        if (args.where.id === 8) return { name: "   " };
        if (args.where.id === 9) return null;
        return { name: "관리김" };
      },
    },
  };
  assert(
    (await resolveNoticeAuthorForAuth(db, { caddyId: 7 })) === "조장김",
    "Caddy-linked admin uses Caddy.name"
  );
  assert(
    (await resolveNoticeAuthorForAuth(db, { caddyId: null })) === "관리자",
    "unlinked admin → 관리자"
  );
  assert(
    (await resolveNoticeAuthorForAuth(db, null)) === "관리자",
    "missing auth → 관리자"
  );
  assert(
    (await resolveNoticeAuthorForAuth(db, { caddyId: 8 })) === "관리자",
    "blank Caddy.name → 관리자"
  );
  assert(
    (await resolveNoticeAuthorForAuth(db, { caddyId: 9 })) === "관리자",
    "missing Caddy row → 관리자"
  );
  const before = calls.length;
  await resolveNoticeAuthorForAuth(db, { caddyId: null });
  assert(calls.length === before, "unlinked admin does not query Caddy");
}

section("client author is ignored");
{
  const parsed = parseNoticeWriteBody(
    { title: "t", content: "c", author: "위조된이름" },
    "create"
  );
  assert(!("author" in parsed), "parseNoticeWriteBody drops client author");
  const updated = parseNoticeWriteBody(
    { title: "t", author: "위조된이름" },
    "update"
  );
  assert(!("author" in updated), "PATCH parse drops client author");
}

section("POST records server author only");
{
  const post = read("src/app/api/notice/route.ts");
  assert(post.includes("resolveNoticeAuthorForAuth"), "POST uses server resolver");
  assert(post.includes("author,"), "POST writes resolved author");
  assert(!post.includes("parsed.author"), "POST ignores parsed.author");
  assert(!post.includes("body.author"), "POST ignores body.author");
  assert(!post.includes("pushSentByUserId"), "POST does not infer from push actor");
}

section("PATCH does not rewrite author");
{
  const patch = read("src/app/api/notice/[id]/route.ts");
  assert(!patch.includes("data.author"), "PATCH does not assign author");
  assert(!patch.includes("parsed.author"), "PATCH ignores parsed.author");
}

section("list and detail render author + time");
{
  const list = read("src/app/notice/page.tsx");
  const detail = read("src/app/notice/[id]/page.tsx");
  assert(list.includes("formatNoticeAuthorDisplay"), "list formats author");
  assert(list.includes("author: true"), "list selects author");
  assert(list.includes("formatKstDisplay(n.createdAt"), "list keeps createdAt");
  assert(list.includes("formatNoticeTargetLabel"), "list still shows target");
  assert(list.includes("notice-badge-important"), "list still shows important");
  assert(list.includes("notice-badge-pinned"), "list still shows pinned");
  assert(list.includes("notice-badge-photo"), "list still shows photo count");
  assert(detail.includes("formatNoticeAuthorDisplay(notice.author)"), "detail formats author");
  assert(detail.includes("작성자"), "detail has 작성자 label");
  assert(detail.includes('formatKstDisplay(notice.createdAt, "ymd-hm")'), "detail keeps createdAt");
  assert(detail.includes("formatNoticeTargetLabel"), "detail still shows target");
  assert(detail.includes("NoticePhotoGallery"), "detail still shows photos");
  assert(detail.includes("NoticePushNotifyCard"), "detail still shows push card");
  assert(!detail.includes("pushSentByUserId"), "detail does not use push actor as author");
}

section("form has no author input");
{
  const form = read("src/app/notice/new/ui/NewNoticeForm.tsx");
  assert(!/\bauthor\b/.test(form), "create/edit form has no author field");
  assert(form.includes("important"), "form still has important");
  assert(form.includes("pinned"), "form still has pinned");
  assert(form.includes("targetType"), "form still has target");
  assert(form.includes("sendPush"), "form still has push");
}

section("no username leak / no schema or chat collision");
{
  const lib = read("src/lib/noticeAuthor.ts");
  assert(!lib.includes("username:"), "resolver has no username param");
  assert(!lib.includes(".username"), "resolver does not read username");
  assert(!lib.includes("pushSentByUserId"), "resolver does not use push actor");
  const schema = read("prisma/schema.prisma");
  assert(schema.includes("author    String?"), "reuses Notice.author");
  assert(!schema.includes("profilePhoto"), "no profile photo schema");
  assert(!fs.existsSync("prisma/migrations/20261011000000_notice_author"), "no new author migration");
}

void testAuthResolver()
  .then(() => {
    if (failed > 0) {
      console.error(`\nFAILED ${failed} / ${passed + failed}`);
      process.exit(1);
    }
    console.log(`\nOK ${passed}`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
