/**
 * 로그인 체감속도 경로 가드 (네트워크/카카오 없음)
 * 실행: npx tsx scripts/test-login-speed-unit.ts
 *
 * Before (callback → /manage first paint):
 *   callback DB: 1 User findUnique (existing Kakao user)
 *   redirect 후 blocking: layout User 1 + dashboard 8 = 9
 *   hydrate 직후 prefetch: /manage 재요청 포함 4 RSC
 * After:
 *   callback DB: 1 User findUnique (unchanged)
 *   redirect 후 shell blocking: layout User 1
 *   dashboard 8: Suspense 뒤로 분리 (shell 비차단)
 *   prefetch: 현재 경로 제외, idle 이후 3 RSC
 */
import fs from "node:fs";
import path from "node:path";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
  verifySignedSessionToken,
} from "../src/lib/sessionCookies";
import { resolveAuthFromCookieStore } from "../src/lib/auth";

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

function cookieJar(map: Record<string, string>) {
  return {
    get(name: string) {
      return map[name] ? { value: map[name] } : undefined;
    },
  };
}

const callbackSrc = read("src/app/api/auth/kakao/callback/route.ts");
const layoutSrc = read("src/app/manage/layout.tsx");
const pageSrc = read("src/app/manage/page.tsx");
const shellSrc = read("src/components/manage/ManageShell.tsx");
const authSrc = read("src/lib/auth.ts");
const sessionSrc = read("src/lib/sessionCookies.ts");
const cachedAuthSrc = read("src/lib/getRequestAuthUser.ts");
const middlewareSrc = read("src/middleware.ts");
const loginClientSrc = read("src/app/login/LoginClient.tsx");

console.log("== before/after query budget (source) ==");
{
  const callbackUserFinds = callbackSrc.split("prisma.user.findUnique").length - 1;
  // existing path uses 1; P2002 retry is a second findUnique in the race branch
  assert(callbackUserFinds === 2, "callback User findUnique: happy path 1 + P2002 retry 1");
  assert(!/prisma\.caddy\./.test(callbackSrc), "callback does not query Caddy");
  assert(
    !/include:\s*\{[^}]*caddy/.test(callbackSrc),
    "callback session issue does not load User↔Caddy"
  );
  assert(callbackSrc.includes("applySessionCookies"), "callback still issues signed session");
  assert(callbackSrc.includes("sessionVersion"), "callback still copies sessionVersion");

  assert(
    cachedAuthSrc.includes("cache(async") &&
      cachedAuthSrc.includes("resolveAuthFromCookieStore"),
    "RSC auth is request-memoized via react cache"
  );
  assert(
    layoutSrc.includes("getRequestAuthUser") &&
      !layoutSrc.includes("prisma."),
    "manage layout uses cached auth, no extra prisma"
  );
  assert(
    layoutSrc.includes('auth.role !== "admin"') &&
      layoutSrc.includes("redirect("),
    "manage layout still rejects non-admin"
  );

  const pagePrisma = pageSrc.split("prisma.").length - 1;
  assert(pagePrisma === 8, "dashboard still 8 queries (count×6 + caddy findMany + notices)");
  assert(pageSrc.includes("Promise.all"), "dashboard queries stay parallel");
  assert(
    pageSrc.includes("export default function ManagePage") &&
      pageSrc.includes("<Suspense") &&
      pageSrc.includes("ManageDashboardData") &&
      pageSrc.includes("ManageDashboardFallback"),
    "page default export is sync Suspense boundary; data is a child"
  );
  assert(
    !/export default async function ManagePage/.test(pageSrc),
    "default page export does not await dashboard queries"
  );
  assert(
    !fs.existsSync(path.resolve("src/app/manage/loading.tsx")),
    "no manage/loading.tsx (would flash on every manage nav)"
  );
}

console.log("== prefetch / refresh ==");
{
  assert(!/router\.refresh\(/.test(shellSrc), "ManageShell does not router.refresh");
  assert(!/router\.refresh\(/.test(loginClientSrc), "LoginClient does not router.refresh");
  assert(
    shellSrc.includes("requestIdleCallback") &&
      shellSrc.includes("filter((href) => href !== pathname)"),
    "prefetch waits for idle and skips the current path"
  );
  assert(
    !/router\.prefetch\("\/manage"\);/.test(shellSrc),
    "does not eagerly prefetch /manage on mount"
  );
}

console.log("== security structure unchanged ==");
{
  assert(middlewareSrc.includes("getVerifiedSessionFromCookies"), "middleware still verifies signature");
  assert(middlewareSrc.includes('session.role !== "admin"'), "middleware still gates /manage admin");
  assert(authSrc.includes("user.sessionVersion !== session.sv"), "sessionVersion still enforced");
  assert(authSrc.includes("user.username !== session.username"), "username still bound to session");
  assert(sessionSrc.includes("timingSafeEqualBytes"), "HMAC compare still timing-safe");
  assert(sessionSrc.includes("hmacKeyPromise"), "HMAC CryptoKey is reused per secret");
  assert(
    cachedAuthSrc.includes("resolveAuthFromCookieStore(await cookies())") &&
      cachedAuthSrc.includes('from "react"'),
    "cached auth delegates to resolveAuthFromCookieStore"
  );
}

console.log("== HMAC cache still verifies ==");
{
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "login-speed-unit-session-secret!!";
  try {
    const claims = buildSessionClaims({
      userId: 9,
      username: "admin_speed",
      role: "admin",
      sessionVersion: 4,
    });
    const a = await signSessionClaims(claims);
    const b = await signSessionClaims(claims);
    const va = await verifySignedSessionToken(a);
    const vb = await verifySignedSessionToken(b);
    assert(!!va && va.sv === 4 && va.role === "admin", "first sign/verify after key cache");
    assert(!!vb && vb.uid === 9, "second sign/verify reuses cached HMAC key");
    assert(
      (await verifySignedSessionToken(a.slice(0, -4) + "zzzz")) === null,
      "tampered signature still rejected with cached key"
    );

    const envTok = await signSessionClaims(
      buildSessionClaims({
        userId: null,
        username: "admin",
        role: "admin",
        sessionVersion: 0,
      })
    );
    const envAuth = await resolveAuthFromCookieStore(
      cookieJar({ [SESSION_COOKIE_NAME]: envTok })
    );
    assert(envAuth?.role === "admin" && envAuth.userId == null, "env admin session still resolves");
  } finally {
    if (prev === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prev;
  }
}

console.log(`\nBEFORE callback DB=1 User | AFTER callback DB=1 User`);
console.log(`BEFORE /manage shell blocking DB=9 (1 auth + 8 dash) | AFTER shell blocking DB=1 auth`);
console.log(`BEFORE hydrate prefetch RSC=4 (includes /manage) | AFTER idle prefetch RSC=3 (skip current)`);
console.log(`DONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
