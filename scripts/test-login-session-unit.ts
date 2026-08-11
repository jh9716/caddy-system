/**
 * 로그인 세션 유틸 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-login-session-unit.ts
 */
import bcrypt from "bcryptjs";
import {
  isHttpsRequest,
  normalizeAppRole,
} from "../src/lib/sessionCookies";
import {
  hasPasswordHash,
  verifyUserPassword,
} from "../src/lib/userPassword";

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

function fakeReq(url: string, headers: Record<string, string> = {}) {
  return {
    url,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? headers[name] ?? null;
      },
    },
    nextUrl: { protocol: new URL(url).protocol },
  } as any;
}

async function main() {
  console.log("== normalizeAppRole ==");
  assert(normalizeAppRole("admin") === "admin", "admin");
  assert(normalizeAppRole("ADMIN") === "admin", "ADMIN→admin");
  assert(normalizeAppRole("caddy") === "caddy", "caddy");
  assert(normalizeAppRole("STAFF") === "caddy", "STAFF→caddy");
  assert(normalizeAppRole("staff") === "caddy", "staff→caddy");
  assert(normalizeAppRole("leader") === "leader", "leader");
  assert(normalizeAppRole("LEADER") === "leader", "LEADER→leader");
  assert(normalizeAppRole("조장") === "leader", "조장→leader");
  assert(normalizeAppRole("nope") === null, "unknown null");

  console.log("== isHttpsRequest ==");
  const prevVercel = process.env.VERCEL;
  delete process.env.VERCEL;

  assert(
    isHttpsRequest(fakeReq("https://caddy-system.vercel.app/api/login")) === true,
    "https url"
  );
  assert(
    isHttpsRequest(
      fakeReq("http://localhost/api/login", { "x-forwarded-proto": "https" })
    ) === true,
    "x-forwarded-proto https"
  );
  assert(
    isHttpsRequest(
      fakeReq("http://localhost/api/login", {
        "x-forwarded-proto": "https, http",
      })
    ) === true,
    "x-forwarded-proto https, http"
  );
  assert(
    isHttpsRequest(fakeReq("http://localhost:3000/api/login")) === false,
    "local http"
  );

  process.env.VERCEL = "1";
  assert(
    isHttpsRequest(fakeReq("http://127.0.0.1/api/login")) === true,
    "VERCEL=1 forces https cookie"
  );
  if (prevVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = prevVercel;

  console.log("== verifyUserPassword null-safe ==");
  assert(hasPasswordHash(null) === false, "null hash rejected");
  assert((await verifyUserPassword("x", null)) === false, "null password → false");
  const h = await bcrypt.hash("pw", 10);
  assert((await verifyUserPassword("pw", h)) === true, "hash login ok");
  assert((await verifyUserPassword("no", h)) === false, "bad password");

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
