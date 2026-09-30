/**
 * C8 member 401 → /login + C9 RETIRED Kakao callback block.
 * 네트워크/카카오/푸시 발송 없음. local only.
 * 실행: npm run test:member-session-c8c9-unit
 */
import fs from "node:fs";
import path from "node:path";
import { isRetiredCaddySessionBlocked } from "../src/lib/auth";
import {
  consumeUnauthorizedMemberResponse,
  isExemptMemberSessionRedirectPath,
  redirectMemberToLogin,
  resetMemberSessionRedirectForTests,
} from "../src/lib/memberSessionRedirect";

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

section("C8 helper: exempt paths (no redirect loop)");
{
  assert(isExemptMemberSessionRedirectPath("/login") === true, "/login exempt");
  assert(isExemptMemberSessionRedirectPath("/login/") === true, "/login/ exempt");
  assert(
    isExemptMemberSessionRedirectPath("/api/auth/kakao/callback") === true,
    "kakao callback exempt"
  );
  assert(isExemptMemberSessionRedirectPath("/privacy") === true, "privacy exempt");
  assert(
    isExemptMemberSessionRedirectPath("/account-deletion") === true,
    "account-deletion exempt"
  );
  assert(isExemptMemberSessionRedirectPath("/manage") === true, "admin /manage exempt");
  assert(
    isExemptMemberSessionRedirectPath("/manage/caddies") === true,
    "admin /manage/caddies exempt"
  );
  assert(isExemptMemberSessionRedirectPath("/assignments") === true, "admin assignments exempt");
  assert(isExemptMemberSessionRedirectPath("/schedule") === true, "admin schedule exempt");
  assert(isExemptMemberSessionRedirectPath("/board") === false, "/board not exempt");
  assert(isExemptMemberSessionRedirectPath("/notice") === false, "/notice not exempt");
  assert(
    isExemptMemberSessionRedirectPath("/course-reports") === false,
    "/course-reports not exempt"
  );
  assert(isExemptMemberSessionRedirectPath("/caddy") === false, "/caddy not exempt");
}

section("C8 helper: one redirect on concurrent 401");
{
  resetMemberSessionRedirectForTests();
  const hrefs: string[] = [];
  const loc = {
    pathname: "/board",
    search: "",
    replace: (href: string) => {
      hrefs.push(href);
    },
  };
  assert(consumeUnauthorizedMemberResponse({ status: 401 }, loc) === true, "first 401 redirects");
  assert(consumeUnauthorizedMemberResponse({ status: 401 }, loc) === true, "second 401 still consumed");
  assert(consumeUnauthorizedMemberResponse({ status: 401 }, loc) === true, "third 401 still consumed");
  assert(hrefs.length === 1, "single location.replace");
  assert(
    hrefs[0] === "/login?callbackUrl=%2Fboard",
    `login callback is /board got ${hrefs[0]}`
  );
  assert(consumeUnauthorizedMemberResponse({ status: 403 }, loc) === false, "403 not expiry");
  assert(consumeUnauthorizedMemberResponse({ status: 503 }, loc) === false, "503 not expiry");
  assert(consumeUnauthorizedMemberResponse({ status: 200 }, loc) === false, "200 no redirect");
}

section("C8 helper: login page never redirects to itself");
{
  resetMemberSessionRedirectForTests();
  const hrefs: string[] = [];
  const loc = {
    pathname: "/login",
    search: "?callbackUrl=%2Fboard",
    replace: (href: string) => {
      hrefs.push(href);
    },
  };
  assert(redirectMemberToLogin(loc) === false, "/login does not redirect");
  assert(hrefs.length === 0, "no replace on /login");
}

section("C8 helper: admin manage keeps existing policy");
{
  resetMemberSessionRedirectForTests();
  const hrefs: string[] = [];
  const loc = {
    pathname: "/manage/caddies",
    search: "",
    replace: (href: string) => {
      hrefs.push(href);
    },
  };
  assert(consumeUnauthorizedMemberResponse({ status: 401 }, loc) === false, "manage 401 not stolen");
  assert(hrefs.length === 0, "admin page no helper replace");
}

section("C8 source: member clients use shared helper");
{
  const board = read("src/app/board/page.tsx");
  const comments = read("src/app/board/BoardComments.tsx");
  const courseForm = read("src/app/course-reports/CourseReportForm.tsx");
  const courseActions = read("src/app/course-reports/[id]/CourseReportDetailActions.tsx");
  const link = read("src/app/caddy/link/CaddyLinkClient.tsx");
  const login = read("src/app/login/LoginClient.tsx");
  const adminDash = read("src/components/manage/AdminOpsDashboard.tsx");
  assert(board.includes("consumeUnauthorizedMemberResponse"), "board page uses helper");
  assert(comments.includes("consumeUnauthorizedMemberResponse"), "board comments uses helper");
  assert(courseForm.includes("consumeUnauthorizedMemberResponse"), "course form uses helper");
  assert(courseActions.includes("consumeUnauthorizedMemberResponse"), "course actions uses helper");
  assert(link.includes("consumeUnauthorizedMemberResponse"), "caddy link uses helper");
  assert(!login.includes("consumeUnauthorizedMemberResponse"), "login form not wrapped");
  assert(
    adminDash.includes('location.href = "/login?callbackUrl=/manage"'),
    "admin dashboard keeps own redirect"
  );
}

section("C9: reuse isRetiredCaddySessionBlocked");
{
  assert(
    isRetiredCaddySessionBlocked({
      role: "caddy",
      caddyId: 1,
      employmentStatus: "RETIRED",
    }) === true,
    "RETIRED caddy blocked"
  );
  assert(
    isRetiredCaddySessionBlocked({
      role: "caddy",
      caddyId: 1,
      employmentStatus: "ACTIVE",
    }) === false,
    "ACTIVE caddy allowed"
  );
  assert(
    isRetiredCaddySessionBlocked({
      role: "caddy",
      caddyId: null,
      employmentStatus: "RETIRED",
    }) === false,
    "unlinked caddy not retired-blocked"
  );
  assert(
    isRetiredCaddySessionBlocked({
      role: "admin",
      caddyId: 1,
      employmentStatus: "RETIRED",
    }) === false,
    "admin not blocked by linked RETIRED"
  );
}

section("C9 source: REST callback blocks before session");
{
  const cb = read("src/app/api/auth/kakao/callback/route.ts");
  const native = read("src/lib/kakaoNativeSession.ts");
  const login = read("src/app/login/LoginClient.tsx");
  const bootstrap = read("src/components/NativePushBootstrap.tsx");
  const nativeToken = read("src/app/api/push/native-token/route.ts");
  assert(cb.includes("isRetiredCaddySessionBlocked"), "callback reuses retired helper");
  assert(cb.includes('redirectLoginError(req, "kakao_retired")'), "callback uses kakao_retired");
  const retiredAt = cb.indexOf("kakao_retired");
  const sessionAt = cb.lastIndexOf("applySessionCookies");
  assert(retiredAt > 0 && sessionAt > retiredAt, "retired check is before applySessionCookies");
  assert(native.includes('error: "kakao_retired"'), "native still kakao_retired");
  assert(native.includes("isRetiredCaddySessionBlocked"), "native still same helper");
  assert(
    login.includes('kakao_retired: "사용할 수 없는 계정입니다."'),
    "existing kakao_retired UI kept"
  );
  assert(
    nativeToken.includes("resolveAuthUser") && nativeToken.includes("unauthorized"),
    "native-token requires resolved auth"
  );
  assert(bootstrap.includes("rebindNativePushTokenOnSession"), "bootstrap rebind unchanged");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
