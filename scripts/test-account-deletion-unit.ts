/**
 * Public account-deletion request safety.
 * Production POST 금지. 로컬 mock + (가능하면) local HTTP GET.
 * 실행: npm run test:account-deletion-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_DELETION_IDENTIFIER_MAX,
  ACCOUNT_DELETION_RATE_LIMIT,
  ACCOUNT_DELETION_REQUEST_ACTION,
  ACCOUNT_DELETION_UNKNOWN_IP,
  AccountDeletionRequestError,
  createAccountDeletionRequest,
  parseAccountDeletionRequest,
  publicDeletionAcceptedBody,
  rateLimitIp,
} from "../src/lib/accountDeletionRequest";
import {
  ACCOUNT_DELETION_PATH,
  ACCOUNT_DELETION_PUBLIC_URL,
  readPrivacyContactEmail,
} from "../src/lib/privacy";

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

section("public path + contact helper");
{
  assert(ACCOUNT_DELETION_PATH === "/account-deletion", "path");
  assert(
    ACCOUNT_DELETION_PUBLIC_URL === "https://www.verthill.kr/account-deletion",
    "public URL"
  );
  assert(readPrivacyContactEmail({}) === null, "missing env does not throw");
  const privacyPage = read("src/app/privacy/page.tsx");
  const deletionPage = read("src/app/account-deletion/page.tsx");
  assert(privacyPage.includes("readPrivacyContactEmail"), "privacy uses same email helper");
  assert(deletionPage.includes("readPrivacyContactEmail"), "deletion uses same email helper");
}

section("parse: valid / email / oversized / XSS / extra secrets");
{
  const ok = parseAccountDeletionRequest({
    accountIdentifier: "kakao_user",
    replyEmail: "user@domain.kr",
    note: "please delete",
    password: "secret",
    token: "abc",
  });
  assert(ok.accountIdentifier === "kakao_user", "identifier kept");
  assert(ok.replyEmail === "user@domain.kr", "email normalized");
  assert(ok.note === "please delete", "note kept");
  assert(!("password" in ok), "password field not stored");
  assert(!("token" in ok), "token field not stored");

  try {
    parseAccountDeletionRequest({
      accountIdentifier: "valid-id",
      replyEmail: "not-an-email",
    });
    assert(false, "malformed email rejected");
  } catch (e) {
    assert(
      e instanceof AccountDeletionRequestError && e.code === "invalid_email",
      "malformed email invalid_email"
    );
  }

  try {
    parseAccountDeletionRequest({
      accountIdentifier: "a".repeat(ACCOUNT_DELETION_IDENTIFIER_MAX + 1),
      replyEmail: "user@domain.kr",
    });
    assert(false, "oversized identifier rejected");
  } catch (e) {
    assert(
      e instanceof AccountDeletionRequestError && e.code === "field_too_long",
      "oversized identifier field_too_long"
    );
  }

  const xss = parseAccountDeletionRequest({
    accountIdentifier: "valid-id",
    replyEmail: "user@domain.kr",
    note: "<script>alert(1)</script>",
  });
  assert(!xss.note?.includes("<"), "XSS brackets stripped from note");
  assert(!xss.note?.includes(">"), "XSS close brackets stripped");
  assert(!xss.note?.includes("<script"), "script tag not stored");
}

async function main() {
section("create writes Audit only + no user lookup");
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
        return { id: 11 };
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

  const existing = await createAccountDeletionRequest(
    db,
    { accountIdentifier: "admin", replyEmail: "user@domain.kr", note: null },
    { ip: "127.0.0.1" }
  );
  const missing = await createAccountDeletionRequest(
    db,
    { accountIdentifier: "no-such-user-zzz", replyEmail: "user@domain.kr", note: null },
    { ip: "127.0.0.1" }
  );
  assert(existing.id === 11 && missing.id === 11, "same create shape");
  assert(userCalls.length === 0, "user.findUnique/delete never called");
  const payload = created[0] as {
    action: string;
    entityId: null;
    payload: Record<string, unknown>;
  };
  assert(payload.action === ACCOUNT_DELETION_REQUEST_ACTION, "action");
  assert(payload.entityId === null, "no user id lookup");
  assert(
    JSON.stringify(Object.keys(payload.payload).sort()) ===
      JSON.stringify(["accountIdentifier", "note", "replyEmail"]),
    "payload keys minimized"
  );
  assert(!("source" in payload.payload), "no extra source cookie/header field");
  assert(publicDeletionAcceptedBody().ok === true, "public success has ok");
  assert(
    Object.keys(publicDeletionAcceptedBody()).join(",") === "ok",
    "public success does not leak audit id"
  );
}

section("rate limit including missing IP");
{
  assert(rateLimitIp(null) === ACCOUNT_DELETION_UNKNOWN_IP, "null IP still bucketed");
  let countedIp = "";
  const db = {
    audit: {
      async count(args: { where: { ip: string } }) {
        countedIp = args.where.ip;
        return ACCOUNT_DELETION_RATE_LIMIT;
      },
      async create() {
        throw new Error("should not create");
      },
    },
  };
  try {
    await createAccountDeletionRequest(
      db,
      { accountIdentifier: "admin", replyEmail: "user@domain.kr", note: null },
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

section("page / API / links — no auto delete / no secret fields");
{
  const page = read("src/app/account-deletion/page.tsx");
  const form = read("src/app/account-deletion/AccountDeletionForm.tsx");
  const route = read("src/app/api/account-deletion-requests/route.ts");
  const lib = read("src/lib/accountDeletionRequest.ts");
  const middleware = read("src/middleware.ts");
  const privacy = read("src/app/privacy/page.tsx");

  assert(page.includes("계정 삭제 요청"), "page title");
  assert(page.includes("AccountDeletionForm"), "form is on the page");
  assert(form.includes("/api/account-deletion-requests"), "form posts to API");
  assert(!form.includes('name="password"'), "form has no password field");
  assert(!form.includes("type=\"password\""), "form has no password input");
  assert(route.includes("publicDeletionAcceptedBody"), "route uses opaque success");
  assert(!route.includes("created.id"), "route does not return audit id");
  assert(!route.includes("user.find"), "route no user lookup");
  assert(!lib.includes("user.delete"), "helper no user.delete");
  assert(!middleware.includes("/account-deletion"), "middleware omits page");
  assert(privacy.includes("계정 식별 정보와 회신 이메일"), "privacy discloses request fields");
}

section("in-app link wiring");
{
  const chrome = read("src/components/manage/AppChrome.tsx");
  const header = read("src/components/AppHeader.tsx");
  const legal = read("src/components/LegalLinks.tsx");
  const login = read("src/app/login/LoginClient.tsx");
  assert(chrome.includes("AccountDeletionLink"), "chrome deletion link");
  assert(header.includes("AccountDeletionLink"), "header deletion link");
  assert(legal.includes("AccountDeletionLink"), "legal cluster includes deletion");
  assert(login.includes("LegalLinks"), "login uses legal cluster");
}

section("local GET /account-deletion 200");
{
  try {
    const res = await fetch("http://127.0.0.1:3000/account-deletion", {
      redirect: "manual",
    });
    assert(res.status === 200, "GET /account-deletion 200");
    const html = await res.text();
    assert(html.includes("계정 삭제 요청"), "GET body has title");
    assert(!html.includes("코드에서 확정된"), "GET has no internal copy");
    const privacy = await fetch("http://127.0.0.1:3000/privacy");
    assert(privacy.status === 200, "GET /privacy 200");
  } catch (e) {
    assert(false, `local GET failed: ${e instanceof Error ? e.message : e}`);
  }
}

section("local POST safety (localhost only)");
{
  const dbUrl = process.env.DATABASE_URL || "";
  assert(/localhost|127\.0\.0\.1/.test(dbUrl), "DATABASE_URL is local");
  const post = async (body: unknown, ip: string) => {
    const res = await fetch("http://127.0.0.1:3000/api/account-deletion-requests", {
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
  const ip = "203.0.113.50";
  const a = await post(
    { accountIdentifier: "admin", replyEmail: "user@domain.kr", note: "local-a" },
    ip
  );
  const b = await post(
    {
      accountIdentifier: "no-such-user-zzz",
      replyEmail: "user@domain.kr",
      note: "local-b",
    },
    ip
  );
  assert(a.status === 200 && b.status === 200, "valid existing/missing both 200");
  assert(a.json.ok === true && b.json.ok === true, "same ok:true");
  assert(a.json.id == null && b.json.id == null, "no audit id leak");
  assert(
    JSON.stringify(Object.keys(a.json).sort()) ===
      JSON.stringify(Object.keys(b.json).sort()),
    "existing vs missing same keys"
  );
  const bad = await post(
    { accountIdentifier: "valid-id", replyEmail: "not-an-email" },
    ip
  );
  assert(bad.status === 400 && bad.json.error === "invalid_email", "malformed email 400");
  const huge = await post(
    {
      accountIdentifier: "z".repeat(ACCOUNT_DELETION_IDENTIFIER_MAX + 1),
      replyEmail: "user@domain.kr",
    },
    ip
  );
  assert(huge.status === 400 && huge.json.error === "field_too_long", "oversized 400");
  const xss = await post(
    {
      accountIdentifier: "valid-id",
      replyEmail: "user@domain.kr",
      note: "<script>alert(1)</script>",
    },
    ip
  );
  assert(xss.status === 200, "XSS note accepted as text");
  assert(!JSON.stringify(xss.json).includes("<script"), "success body has no script");
}

if (failed > 0) {
  console.error(`\naccount-deletion tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\naccount-deletion tests passed: ${passed}`);
}

void main();
