/**
 * Public privacy inquiry + admin inbox.
 * Production POST 금지. 로컬 mock + (가능하면) local HTTP.
 * 실행: npm run test:privacy-inquiry-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_DELETION_IDENTIFIER_MAX,
  ACCOUNT_DELETION_NOTE_MAX,
  ACCOUNT_DELETION_REQUEST_ACTION,
  ACCOUNT_DELETION_UNKNOWN_IP,
  AccountDeletionRequestError,
  createAccountDeletionRequest,
  rateLimitIp,
} from "../src/lib/accountDeletionRequest";
import {
  PRIVACY_CONTACT_PATH,
  PRIVACY_CONTACT_PUBLIC_URL,
  PRIVACY_REQUESTS_ADMIN_PATH,
} from "../src/lib/privacy";
import {
  PRIVACY_INQUIRY_ACTION,
  PRIVACY_INQUIRY_MESSAGE_MAX,
  PRIVACY_INQUIRY_RATE_LIMIT,
  createPrivacyInquiryRequest,
  parsePrivacyInquiryRequest,
  publicPrivacyInquiryAcceptedBody,
} from "../src/lib/privacyInquiryRequest";
import {
  listPrivacyRequests,
  toAdminPrivacyRequestRow,
} from "../src/lib/privacyRequestInbox";

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

section("public path + no secret fields");
{
  assert(PRIVACY_CONTACT_PATH === "/privacy-contact", "inquiry path");
  assert(
    PRIVACY_CONTACT_PUBLIC_URL === "https://www.verthill.kr/privacy-contact",
    "inquiry public URL"
  );
  assert(PRIVACY_REQUESTS_ADMIN_PATH === "/manage/privacy-requests", "admin inbox path");
  const form = read("src/app/privacy-contact/PrivacyInquiryForm.tsx");
  assert(!form.includes('name="password"'), "form has no password field");
  assert(!form.includes('type="password"'), "form has no password input");
  assert(!form.includes("token"), "form has no token field");
  assert(form.includes("/api/privacy-inquiries"), "form posts to inquiry API");
  assert(form.includes("ACCOUNT_DELETION_PATH"), "deletion topic guides to deletion page");
}

section("parse: valid / malformed / oversized / XSS / extra secrets");
{
  const ok = parsePrivacyInquiryRequest({
    topic: "privacy_inquiry",
    replyEmail: "user@domain.kr",
    message: "what data do you store",
    password: "secret",
    token: "abc",
  });
  assert(ok.kind === "inquiry", "inquiry kind");
  if (ok.kind === "inquiry") {
    assert(ok.input.replyEmail === "user@domain.kr", "email normalized");
    assert(ok.input.topic === "privacy_inquiry", "topic kept");
    assert(ok.input.message === "what data do you store", "message kept");
    assert(!("password" in ok.input), "password not stored");
    assert(!("token" in ok.input), "token not stored");
  }

  const access = parsePrivacyInquiryRequest({
    topic: "access_or_correction",
    replyEmail: "user@domain.kr",
    message: "please correct my name",
  });
  assert(access.kind === "inquiry" && access.input.topic === "access_or_correction", "access topic");

  const deletion = parsePrivacyInquiryRequest({
    topic: "account_deletion",
    accountIdentifier: "kakao_user",
    replyEmail: "user@domain.kr",
    message: "please delete",
  });
  assert(deletion.kind === "deletion", "deletion topic reuses deletion parse");
  if (deletion.kind === "deletion") {
    assert(deletion.input.accountIdentifier === "kakao_user", "identifier reused");
    assert(deletion.input.note === "please delete", "message maps to note");
  }

  try {
    parsePrivacyInquiryRequest({
      topic: "privacy_inquiry",
      replyEmail: "not-an-email",
      message: "hello there",
    });
    assert(false, "malformed email rejected");
  } catch (e) {
    assert(
      e instanceof AccountDeletionRequestError && e.code === "invalid_email",
      "malformed email invalid_email"
    );
  }

  try {
    parsePrivacyInquiryRequest({
      topic: "privacy_inquiry",
      replyEmail: "user@domain.kr",
      message: "x".repeat(PRIVACY_INQUIRY_MESSAGE_MAX + 1),
    });
    assert(false, "oversized message rejected");
  } catch (e) {
    assert(
      e instanceof AccountDeletionRequestError && e.code === "field_too_long",
      "oversized message field_too_long"
    );
  }

  try {
    parsePrivacyInquiryRequest({
      topic: "account_deletion",
      accountIdentifier: "a".repeat(ACCOUNT_DELETION_IDENTIFIER_MAX + 1),
      replyEmail: "user@domain.kr",
      message: "please delete",
    });
    assert(false, "oversized identifier rejected");
  } catch (e) {
    assert(
      e instanceof AccountDeletionRequestError && e.code === "field_too_long",
      "oversized identifier field_too_long"
    );
  }

  const xss = parsePrivacyInquiryRequest({
    topic: "privacy_inquiry",
    replyEmail: "user@domain.kr",
    message: "<script>alert(1)</script>",
  });
  assert(xss.kind === "inquiry", "xss parsed as inquiry");
  if (xss.kind === "inquiry") {
    assert(!xss.input.message.includes("<"), "XSS brackets stripped from message");
    assert(!xss.input.message.includes(">"), "XSS close brackets stripped");
    assert(!xss.input.message.includes("<script"), "script tag not stored");
  }
}

async function main() {
section("create writes Audit only + no user lookup + no enumeration");
{
  const created: unknown[] = [];
  const userCalls: string[] = [];
  const db = {
    audit: {
      async count() {
        return 0;
      },
      async create(args: { data: unknown }) {
        created.push(args.data);
        return { id: 22 };
      },
    },
    user: {
      async findUnique() {
        userCalls.push("findUnique");
        return { id: 1 };
      },
      async delete() {
        userCalls.push("delete");
        return {};
      },
    },
  };

  const first = await createPrivacyInquiryRequest(
    db,
    { replyEmail: "user@domain.kr", topic: "privacy_inquiry", message: "hello" },
    { ip: "127.0.0.1" }
  );
  const second = await createPrivacyInquiryRequest(
    db,
    { replyEmail: "other@domain.kr", topic: "access_or_correction", message: "fix" },
    { ip: "127.0.0.1" }
  );
  assert(first.id === 22 && second.id === 22, "same create shape");
  assert(userCalls.length === 0, "user.findUnique/delete never called");
  const payload = created[0] as {
    action: string;
    entityId: null;
    payload: Record<string, unknown>;
  };
  assert(payload.action === PRIVACY_INQUIRY_ACTION, "inquiry action");
  assert(payload.entityId === null, "no user id lookup");
  assert(
    JSON.stringify(Object.keys(payload.payload).sort()) ===
      JSON.stringify(["message", "replyEmail", "topic"]),
    "payload keys minimized"
  );
  assert(publicPrivacyInquiryAcceptedBody().ok === true, "public success has ok");
  assert(
    Object.keys(publicPrivacyInquiryAcceptedBody()).join(",") === "ok",
    "public success does not leak audit id"
  );

  const deletionCreated: unknown[] = [];
  const deletionDb = {
    audit: {
      async count() {
        return 0;
      },
      async create(args: { data: unknown }) {
        deletionCreated.push(args.data);
        return { id: 33 };
      },
    },
  };
  await createAccountDeletionRequest(
    deletionDb,
    { accountIdentifier: "admin", replyEmail: "user@domain.kr", note: "from inquiry" },
    { ip: "127.0.0.1" }
  );
  const deletion = deletionCreated[0] as { action: string };
  assert(deletion.action === ACCOUNT_DELETION_REQUEST_ACTION, "deletion topic uses deletion action");
}

section("rate limit is Audit.count, including missing IP");
{
  assert(rateLimitIp(null) === ACCOUNT_DELETION_UNKNOWN_IP, "null IP still bucketed");
  const lib = read("src/lib/privacyInquiryRequest.ts");
  const deletionLib = read("src/lib/accountDeletionRequest.ts");
  assert(lib.includes("db.audit.count"), "inquiry rate limit uses Audit.count");
  assert(deletionLib.includes("db.audit.count"), "deletion rate limit uses Audit.count");
  assert(lib.includes("기본 abuse mitigation"), "inquiry does not claim strong security");
  assert(deletionLib.includes("기본 abuse mitigation"), "deletion does not claim strong security");
  assert(!lib.includes("Map<") && !lib.includes("memory"), "inquiry not in-process memory map");
  let countedIp = "";
  const db = {
    audit: {
      async count(args: { where: { ip: string } }) {
        countedIp = args.where.ip;
        return PRIVACY_INQUIRY_RATE_LIMIT;
      },
      async create() {
        throw new Error("should not create");
      },
    },
  };
  try {
    await createPrivacyInquiryRequest(
      db,
      { replyEmail: "user@domain.kr", topic: "privacy_inquiry", message: "hello" },
      { ip: null }
    );
    assert(false, "missing IP still rate limited");
  } catch (e) {
    assert(
      e instanceof AccountDeletionRequestError && e.status === 429,
      "429 without client IP"
    );
    assert(countedIp === ACCOUNT_DELETION_UNKNOWN_IP, "unknown IP used for count");
  }
}

section("admin inbox maps Audit without secrets or delete actions");
{
  const row = toAdminPrivacyRequestRow({
    id: 9,
    action: ACCOUNT_DELETION_REQUEST_ACTION,
    createdAt: new Date("2026-09-22T01:02:03.000Z"),
    payload: {
      accountIdentifier: "admin",
      replyEmail: "user@domain.kr",
      note: "please delete",
      ip: "should-not-surface",
      token: "secret",
      session: "cookie",
    },
  });
  assert(row.kind === ACCOUNT_DELETION_REQUEST_ACTION, "deletion kind");
  assert(row.accountIdentifier === "admin", "identifier shown");
  assert(row.replyEmail === "user@domain.kr", "email shown");
  assert(row.note === "please delete", "note shown");
  assert(row.topic === "account_deletion", "deletion topic inferred");
  assert(!("ip" in row), "admin row has no ip");
  assert(!("token" in row), "admin row has no token");
  assert(!("session" in row), "admin row has no session");
  assert(!("payload" in row), "admin row has no raw payload");

  const inquiry = toAdminPrivacyRequestRow({
    id: 10,
    action: PRIVACY_INQUIRY_ACTION,
    createdAt: new Date("2026-09-22T01:02:04.000Z"),
    payload: {
      replyEmail: "ask@domain.kr",
      topic: "privacy_inquiry",
      message: "<b>hello</b>",
    },
  });
  assert(inquiry.note === "<b>hello</b>" || inquiry.note === "hello", "message mapped to note");
  assert(inquiry.topic === "privacy_inquiry", "inquiry topic kept");

  const listed = await listPrivacyRequests({
    audit: {
      async findMany(args) {
        assert(
          JSON.stringify(args.select) ===
            JSON.stringify({ id: true, action: true, createdAt: true, payload: true }),
          "findMany does not select ip"
        );
        return [
          {
            id: 1,
            action: ACCOUNT_DELETION_REQUEST_ACTION,
            createdAt: new Date("2026-09-22T00:00:00.000Z"),
            payload: { accountIdentifier: "a", replyEmail: "a@domain.kr", note: "n" },
          },
        ];
      },
    },
  });
  assert(listed.length === 1 && listed[0].accountIdentifier === "a", "list maps rows");
}

section("page / API / admin — no auto delete");
{
  const page = read("src/app/privacy-contact/page.tsx");
  const route = read("src/app/api/privacy-inquiries/route.ts");
  const adminRoute = read("src/app/api/admin/privacy-requests/route.ts");
  const adminPage = read("src/app/manage/privacy-requests/page.tsx");
  const inbox = read("src/app/manage/privacy-requests/PrivacyRequestsInbox.tsx");
  const middleware = read("src/middleware.ts");
  const privacy = read("src/app/privacy/page.tsx");
  const nav = read("src/components/manage/ManageShell.tsx");

  assert(page.includes("PRIVACY_CONTACT_LINK_LABEL"), "public inquiry title");
  assert(page.includes("PrivacyInquiryForm"), "form is on the page");
  assert(route.includes("publicPrivacyInquiryAcceptedBody"), "route uses opaque success");
  assert(!route.includes("created.id"), "route does not return audit id");
  assert(!route.includes("user.find"), "inquiry route no user lookup");
  assert(adminRoute.includes("requireAdmin"), "admin list requireAdmin");
  assert(adminRoute.includes("listPrivacyRequests"), "admin list uses inbox helper");
  assert(!adminRoute.includes("user.delete"), "admin API no user.delete");
  assert(adminPage.includes("PrivacyRequestsInbox"), "admin page renders inbox");
  assert(inbox.includes("요청 시각"), "inbox shows time");
  assert(inbox.includes("계정 식별"), "inbox shows identifier");
  assert(inbox.includes("회신 이메일"), "inbox shows reply email");
  assert(!inbox.includes("삭제하기") && !inbox.includes("익명화하기"), "inbox has no delete/anonymize button");
  assert(!inbox.includes("row.ip") && !inbox.includes("session") && !inbox.includes("token"), "inbox UI no secrets");
  assert(nav.includes("/manage/privacy-requests"), "manage nav has inbox");
  assert(privacy.includes("PRIVACY_CONTACT_PATH"), "privacy links inquiry");
  assert(!middleware.includes("/privacy-contact"), "middleware omits inquiry page");
}

section("local GET public pages 200");
{
  try {
    const contact = await fetch("http://127.0.0.1:3000/privacy-contact", {
      redirect: "manual",
    });
    assert(contact.status === 200, "GET /privacy-contact 200");
    const html = await contact.text();
    assert(html.includes("개인정보 문의"), "GET body has title");
    assert(!html.includes("코드에서 확정된"), "GET has no internal copy");

    const privacy = await fetch("http://127.0.0.1:3000/privacy");
    assert(privacy.status === 200, "GET /privacy 200");
    const privacyHtml = await privacy.text();
    assert(privacyHtml.includes("공개 문의 폼"), "privacy mentions inquiry form");
    assert(privacyHtml.includes("/privacy-contact") || privacyHtml.includes("privacy-contact"), "privacy links inquiry");

    const deletion = await fetch("http://127.0.0.1:3000/account-deletion");
    assert(deletion.status === 200, "GET /account-deletion 200");
  } catch (e) {
    assert(false, `local GET failed: ${e instanceof Error ? e.message : e}`);
  }
}

section("local POST inquiry + admin forbidden (localhost only)");
{
  const dbUrl = process.env.DATABASE_URL || "";
  assert(/localhost|127\.0\.0\.1/.test(dbUrl), "DATABASE_URL is local");
  const post = async (body: unknown, ip: string) => {
    const res = await fetch("http://127.0.0.1:3000/api/privacy-inquiries", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  };
  const ip = "203.0.113.77";
  const a = await post(
    {
      topic: "privacy_inquiry",
      replyEmail: "user@domain.kr",
      message: "local-inquiry-a",
    },
    ip
  );
  const b = await post(
    {
      topic: "access_or_correction",
      replyEmail: "missing-user@domain.kr",
      message: "local-inquiry-b",
    },
    ip
  );
  assert(a.status === 200 && b.status === 200, "valid inquiry both 200");
  assert(a.json.ok === true && b.json.ok === true, "same ok:true");
  assert(a.json.id == null && b.json.id == null, "no audit id leak");
  assert(
    JSON.stringify(Object.keys(a.json).sort()) ===
      JSON.stringify(Object.keys(b.json).sort()),
    "existing vs missing same keys"
  );

  const bad = await post(
    { topic: "privacy_inquiry", replyEmail: "not-an-email", message: "hello there" },
    ip
  );
  assert(bad.status === 400 && bad.json.error === "invalid_email", "malformed email 400");
  const huge = await post(
    {
      topic: "privacy_inquiry",
      replyEmail: "user@domain.kr",
      message: "z".repeat(ACCOUNT_DELETION_NOTE_MAX + 1),
    },
    ip
  );
  assert(huge.status === 400 && huge.json.error === "field_too_long", "oversized 400");
  const xss = await post(
    {
      topic: "privacy_inquiry",
      replyEmail: "user@domain.kr",
      message: "<script>alert(1)</script>",
    },
    ip
  );
  assert(xss.status === 200, "XSS message accepted as text");
  assert(!JSON.stringify(xss.json).includes("<script"), "success body has no script");

  const admin = await fetch("http://127.0.0.1:3000/api/admin/privacy-requests", {
    redirect: "manual",
  });
  assert(admin.status === 401, "non-admin GET inbox 401");
  const adminJson = (await admin.json().catch(() => ({}))) as Record<string, unknown>;
  assert(adminJson.error === "unauthorized", "non-admin forbidden body");
}

if (failed > 0) {
  console.error(`\nprivacy-inquiry tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nprivacy-inquiry tests passed: ${passed}`);
}

void main();
