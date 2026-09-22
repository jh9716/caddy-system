/**
 * Public account-deletion request. No production DB. No actual User delete.
 * 실행: npm run test:account-deletion-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_DELETION_RATE_LIMIT,
  ACCOUNT_DELETION_REQUEST_ACTION,
  AccountDeletionRequestError,
  createAccountDeletionRequest,
  parseAccountDeletionRequest,
} from "../src/lib/accountDeletionRequest";
import {
  ACCOUNT_DELETION_PATH,
  ACCOUNT_DELETION_PUBLIC_URL,
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

section("public path");
{
  assert(ACCOUNT_DELETION_PATH === "/account-deletion", "path");
  assert(
    ACCOUNT_DELETION_PUBLIC_URL === "https://www.verthill.kr/account-deletion",
    "public URL"
  );
}

section("parse request");
{
  const ok = parseAccountDeletionRequest({
    accountIdentifier: "kakao_user",
    replyEmail: "user@domain.kr",
    note: "please delete",
  });
  assert(ok.accountIdentifier === "kakao_user", "identifier kept");
  assert(ok.replyEmail === "user@domain.kr", "email normalized");
  assert(ok.note === "please delete", "note kept");

  try {
    parseAccountDeletionRequest({ accountIdentifier: "x", replyEmail: "a@b.kr" });
    assert(false, "short identifier rejected");
  } catch (e) {
    assert(e instanceof AccountDeletionRequestError, "short identifier error");
  }

  try {
    parseAccountDeletionRequest({
      accountIdentifier: "valid-id",
      replyEmail: "privacy@example.com",
    });
    assert(false, "example.com rejected");
  } catch (e) {
    assert(
      e instanceof AccountDeletionRequestError && e.code === "invalid_email",
      "example.com invalid_email"
    );
  }

  try {
    parseAccountDeletionRequest({
      accountIdentifier: "valid-id",
      replyEmail: "user@domain.kr",
      company: "bot",
    });
    assert(false, "honeypot rejected");
  } catch (e) {
    assert(e instanceof AccountDeletionRequestError, "honeypot error");
  }
}

async function main() {
section("create writes Audit only");
{
  const created: unknown[] = [];
  const deleted: unknown[] = [];
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
      async delete(args: unknown) {
        deleted.push(args);
        return args;
      },
    },
  };

  const row = await createAccountDeletionRequest(
    db,
    {
      accountIdentifier: "admin",
      replyEmail: "user@domain.kr",
      note: null,
    },
    { ip: "127.0.0.1" }
  );
  assert(row.id === 11, "returns audit id");
  assert(created.length === 1, "one audit create");
  const payload = created[0] as {
    action: string;
    entity: string;
    entityId: null;
    payload: { source: string; accountIdentifier: string };
  };
  assert(payload.action === ACCOUNT_DELETION_REQUEST_ACTION, "action");
  assert(payload.entity === "User", "entity User");
  assert(payload.entityId === null, "no user id lookup");
  assert(payload.payload.source === "web_form", "web_form source");
  assert(payload.payload.accountIdentifier === "admin", "identifier stored");
  assert(deleted.length === 0, "user.delete never called");
}

section("rate limit");
{
  const db = {
    audit: {
      async count() {
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
      { ip: "1.1.1.1" }
    );
    assert(false, "rate limit throws");
  } catch (e) {
    assert(
      e instanceof AccountDeletionRequestError && e.status === 429,
      "429 rate limited"
    );
  }
}

section("page / API / links — no auto delete");
{
  const page = read("src/app/account-deletion/page.tsx");
  const form = read("src/app/account-deletion/AccountDeletionForm.tsx");
  const route = read("src/app/api/account-deletion-requests/route.ts");
  const lib = read("src/lib/accountDeletionRequest.ts");
  const middleware = read("src/middleware.ts");

  assert(page.includes("계정 삭제 요청"), "page title");
  assert(page.includes("삭제 또는 익명화"), "delete/anonymize section");
  assert(page.includes("업무상 보존"), "retain section");
  assert(page.includes("AccountDeletionForm"), "form is on the page");
  assert(page.includes("로그인 없이"), "public access stated");
  assert(form.includes("/api/account-deletion-requests"), "form posts to API");
  assert(form.includes("삭제 요청 보내기"), "submit starts request");
  assert(route.includes("createAccountDeletionRequest"), "route uses helper");
  assert(!route.includes("user.delete"), "route no user.delete");
  assert(!lib.includes("user.delete"), "helper no user.delete");
  assert(!middleware.includes("/account-deletion"), "middleware omits page");
  assert(!page.includes("코드에서 확정된"), "no internal placeholder copy");
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

if (failed > 0) {
  console.error(`\naccount-deletion tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\naccount-deletion tests passed: ${passed}`);
}

void main();
