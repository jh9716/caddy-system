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
  isMemberSessionRedirectScheduled,
  redirectMemberToLogin,
  resetMemberSessionRedirectForTests,
} from "../src/lib/memberSessionRedirect";
import { safeReturnPath } from "../src/lib/safeReturnPath";

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
    isExemptMemberSessionRedirectPath("/privacy-contact") === true,
    "privacy-contact exempt"
  );
  assert(
    isExemptMemberSessionRedirectPath("/privacy-contact/extra") === true,
    "privacy-contact child exempt"
  );
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
  assert(
    isExemptMemberSessionRedirectPath("/off-requests") === false,
    "/off-requests not exempt"
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
  assert(isMemberSessionRedirectScheduled() === true, "scheduled flag stays set after 401s");
}

section("C8 helper: callbackUrl keeps pathname + query");
{
  resetMemberSessionRedirectForTests();
  const hrefs: string[] = [];
  const loc = {
    pathname: "/board",
    search: "?date=2026-09-30&shift=1%EB%B6%80",
    replace: (href: string) => {
      hrefs.push(href);
    },
  };
  assert(redirectMemberToLogin(loc) === true, "redirect with query");
  assert(hrefs.length === 1, "one replace for query case");
  const expectedCb = "/board?date=2026-09-30&shift=1%EB%B6%80";
  assert(
    hrefs[0] === `/login?callbackUrl=${encodeURIComponent(expectedCb)}`,
    `callbackUrl preserves query got ${hrefs[0]}`
  );
  assert(redirectMemberToLogin(loc) === true, "already scheduled still consumed");
  assert(hrefs.length === 1, "second call does not replace again");
}

section("C8 helper: open redirect rejected");
{
  resetMemberSessionRedirectForTests();
  const hrefs: string[] = [];
  const loc = {
    pathname: "//evil.example",
    search: "",
    replace: (href: string) => {
      hrefs.push(href);
    },
  };
  assert(safeReturnPath("//evil.example") === null, "safeReturnPath blocks protocol-relative");
  assert(safeReturnPath("https://evil.example") === null, "safeReturnPath blocks absolute");
  assert(redirectMemberToLogin(loc) === true, "unsafe path still redirects to login");
  assert(
    hrefs[0] === "/login?callbackUrl=%2Fcaddy",
    `unsafe callback falls back to /caddy got ${hrefs[0]}`
  );
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
  const courseComments = read("src/app/course-reports/[id]/CourseReportComments.tsx");
  const noticeForm = read("src/app/notice/new/ui/NewNoticeForm.tsx");
  const noticeActions = read("src/app/notice/[id]/NoticeActions.tsx");
  const noticeDetail = read("src/components/notice/NoticeDetailActions.tsx");
  const noticePush = read("src/components/notice/NoticePushNotifyCard.tsx");
  const noticePhoto = read("src/lib/noticePhotoClient.ts");
  const coursePhoto = read("src/lib/courseReportPhotoClient.ts");
  const link = read("src/app/caddy/link/CaddyLinkClient.tsx");
  const caddy = read("src/app/caddy/page.tsx");
  const webPush = read("src/components/PushNotificationCard.tsx");
  const nativeCard = read("src/components/NativePushNotificationCard.tsx");
  const login = read("src/app/login/LoginClient.tsx");
  const adminDash = read("src/components/manage/AdminOpsDashboard.tsx");
  const manageCaddies = read("src/app/manage/caddies/page.tsx");
  const manageUsers = read("src/app/manage/users/page.tsx");
  const schedule = read("src/app/schedule/page.tsx");
  const assignments = read("src/app/assignments/page.tsx");
  const changePw = read("src/app/change-password/ChangePasswordClient.tsx");
  const privacyContact = read("src/app/privacy-contact/PrivacyInquiryForm.tsx");
  const accountDel = read("src/app/account-deletion/AccountDeletionForm.tsx");

  assert(board.includes("consumeUnauthorizedMemberResponse"), "board page uses helper");
  assert(board.includes("isMemberSessionRedirectScheduled"), "board skips setState after redirect");
  assert(comments.includes("consumeUnauthorizedMemberResponse"), "board comments uses helper");
  assert(courseForm.includes("consumeUnauthorizedMemberResponse"), "course form uses helper");
  assert(
    courseForm.includes("isMemberSessionRedirectScheduled"),
    "course form skips photo toast after redirect"
  );
  assert(courseActions.includes("consumeUnauthorizedMemberResponse"), "course actions uses helper");
  assert(courseComments.includes("consumeUnauthorizedMemberResponse"), "course comments uses helper");
  assert(noticeForm.includes("consumeUnauthorizedMemberResponse"), "notice form uses helper");
  assert(
    noticeForm.includes("isMemberSessionRedirectScheduled"),
    "notice form skips photo toast after redirect"
  );
  assert(noticeActions.includes("consumeUnauthorizedMemberResponse"), "notice actions uses helper");
  assert(noticeDetail.includes("consumeUnauthorizedMemberResponse"), "notice detail uses helper");
  assert(noticePush.includes("consumeUnauthorizedMemberResponse"), "notice push preview uses helper");
  assert(noticePhoto.includes("consumeUnauthorizedMemberResponse"), "notice photo upload uses helper");
  assert(coursePhoto.includes("consumeUnauthorizedMemberResponse"), "course photo upload uses helper");
  assert(link.includes("consumeUnauthorizedMemberResponse"), "caddy link uses helper");
  assert(link.includes("/api/caddy-link-requests/mine"), "caddy link GET mine");
  {
    const postAt = link.indexOf('fetch("/api/caddy-link-requests",');
    const cancelAt = link.indexOf("fetch(`/api/caddy-link-requests/${req.id}/cancel`");
    assert(postAt > 0, "caddy link POST present");
    assert(cancelAt > 0, "caddy link cancel present");
    assert(
      link.slice(postAt, postAt + 420).includes("consumeUnauthorizedMemberResponse"),
      "caddy link POST uses helper"
    );
    assert(
      link.slice(cancelAt, cancelAt + 420).includes("consumeUnauthorizedMemberResponse"),
      "caddy link cancel uses helper"
    );
  }
  assert(caddy.includes("consumeUnauthorizedMemberResponse"), "caddy dashboard uses helper");
  assert(caddy.includes("redirectMemberToLogin"), "caddy null-role uses login helper");
  assert(caddy.includes("r.status === 200 && !d.role"), "caddy 200+null role → login");
  assert(webPush.includes("consumeUnauthorizedMemberResponse"), "web push card uses helper");
  assert(nativeCard.includes("consumeUnauthorizedMemberResponse"), "native push card uses helper");
  assert(!login.includes("consumeUnauthorizedMemberResponse"), "login form not wrapped");
  assert(!changePw.includes("consumeUnauthorizedMemberResponse"), "change-password keeps form 401");
  assert(!privacyContact.includes("consumeUnauthorizedMemberResponse"), "privacy-contact public form");
  assert(!accountDel.includes("consumeUnauthorizedMemberResponse"), "account-deletion public form");
  assert(!manageCaddies.includes("consumeUnauthorizedMemberResponse"), "manage caddies no helper");
  assert(!manageUsers.includes("consumeUnauthorizedMemberResponse"), "manage users no helper");
  assert(!schedule.includes("consumeUnauthorizedMemberResponse"), "schedule no helper");
  assert(!assignments.includes("consumeUnauthorizedMemberResponse"), "assignments no helper");
  assert(
    adminDash.includes('location.href = "/login?callbackUrl=/manage"'),
    "admin dashboard keeps own redirect"
  );
}

section("C8 source: logout / native rebind do not use helper");
{
  const logout = read("src/lib/logoutClient.ts");
  const nav = read("src/components/NavBar.tsx");
  const bridge = read("src/lib/nativePushBridge.ts");
  const webLogout = read("src/lib/webPushLogout.ts");
  const bootstrap = read("src/components/NativePushBootstrap.tsx");
  const changePw = read("src/app/change-password/ChangePasswordClient.tsx");
  assert(!logout.includes("memberSessionRedirect"), "logoutClient no helper import");
  assert(!nav.includes("memberSessionRedirect"), "NavBar logout no helper");
  assert(!bridge.includes("memberSessionRedirect"), "nativePushBridge no helper");
  assert(!webLogout.includes("memberSessionRedirect"), "webPushLogout no helper");
  assert(!changePw.includes("memberSessionRedirect"), "change-password logout no helper");
  assert(bridge.includes('if (res.status === 401) return "unauthorized"'), "bridge 401 stays local");
  assert(bootstrap.includes("rebindNativePushTokenOnSession"), "bootstrap rebind unchanged");
  assert(!bootstrap.includes("consumeUnauthorizedMemberResponse"), "bootstrap no helper");
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
  const oauth = read("src/lib/kakaoOAuth.ts");
  const findOrCreate = read("src/lib/kakaoSessionUser.ts");
  assert(cb.includes("isRetiredCaddySessionBlocked"), "callback reuses retired helper");
  assert(cb.includes('redirectLoginError(req, "kakao_retired")'), "callback uses kakao_retired");
  const lookupAt = cb.indexOf("findOrCreateKakaoSessionUser");
  const retiredAt = cb.indexOf("kakao_retired");
  const destAt = cb.lastIndexOf("resolvePostLoginHref");
  const sessionAt = cb.lastIndexOf("applySessionCookies");
  assert(lookupAt > 0, "user/caddy lookup present");
  assert(retiredAt > lookupAt, "RETIRED check is after user lookup");
  assert(destAt > retiredAt, "post-login dest is after RETIRED return");
  assert(sessionAt > destAt, "session cookies only after dest (ACTIVE path)");
  const redirectFn = cb.slice(
    cb.indexOf("function redirectLoginError"),
    cb.indexOf("function clearOAuthCookies")
  );
  assert(!redirectFn.includes("applySessionCookies"), "retired redirect issues no session");
  assert(!redirectFn.includes("SESSION_COOKIE_NAME"), "retired redirect no vh_session name");
  assert(!redirectFn.includes("vh_session"), "retired redirect no vh_session cookie");
  assert(redirectFn.includes("error"), "retired redirect passes error query");
  assert(redirectFn.includes("/login"), "retired redirect goes to /login");
  assert(redirectFn.includes("clearOAuthCookies"), "retired redirect clears OAuth only");
  assert(cb.includes("statesMatch"), "Kakao state check kept");
  assert(cb.includes("safeReturnPath"), "Kakao return-path check kept");
  assert(oauth.includes("statesMatch"), "OAuth state helper unchanged");
  assert(findOrCreate.includes("kakaoUserId"), "findOrCreate still shared");
  assert(native.includes('error: "kakao_retired"'), "native still kakao_retired");
  assert(native.includes("isRetiredCaddySessionBlocked"), "native still same helper");
  {
    const nativeRetired = native.indexOf('error: "kakao_retired"');
    const nativeOk = native.lastIndexOf("ok: true");
    assert(nativeRetired > 0 && nativeOk > nativeRetired, "native retired before session ok");
  }
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

section("C6/C9 server still enforces auth without client helper");
{
  const auth = read("src/lib/auth.ts");
  const caddyLayout = read("src/app/caddy/layout.tsx");
  const noticeLayout = read("src/app/notice/layout.tsx");
  const courseLayout = read("src/app/course-reports/layout.tsx");
  const mw = read("src/middleware.ts");
  const helper = read("src/lib/memberSessionRedirect.ts");
  assert(auth.includes("isRetiredCaddySessionBlocked"), "resolveAuthUser still blocks RETIRED");
  assert(caddyLayout.includes("getRequestAuthUser"), "caddy layout server-enforced");
  assert(noticeLayout.includes("getRequestAuthUser"), "notice layout server-enforced");
  assert(courseLayout.includes("getRequestAuthUser"), "course layout server-enforced");
  assert(mw.includes('pathname.startsWith("/caddy")'), "middleware still gates /caddy");
  assert(!helper.includes("requireAdmin"), "client helper is not a server guard");
  assert(helper.includes("res.status !== 401"), "helper is 401-only UX");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
