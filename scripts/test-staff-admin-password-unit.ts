/**
 * 경기과 직원 관리자 계정: 임시 비밀번호 / 강제 변경 / 우회 차단 / reset
 *
 * 평문 임시 비밀번호를 로그·fixture에 남기지 않는다.
 * Production write 금지 (localhost만).
 *
 *   npx tsx scripts/test-staff-admin-password-unit.ts
 */
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { requireAdmin, requireAccountManager, resolveAuthFromCookieStore } from "../src/lib/auth";
import {
  BANNED_TEMP_NUMERIC_PASSWORDS,
  isBannedTempNumericPassword,
  newPasswordIssueMessage,
  postLoginPath,
  shouldForcePasswordChange,
  validateNewPassword,
  validatePasswordConfirm,
} from "../src/lib/passwordPolicy";
import {
  generateDistinctTempNumericPasswords,
  generateTempNumericPassword,
  verifyUserPassword,
} from "../src/lib/userPassword";
import {
  STAFF_ADMIN_USERNAMES,
  SUPER_ADMIN_USERNAME,
  isAccountManagerAuth,
} from "../src/lib/staffAdminAccounts";
import { manageNavItems } from "../src/components/manage/ManageShell";
import { middleware } from "../src/middleware";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";

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

function assertLocalDatabaseUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL parse 실패 — 로컬 테스트 중단");
  }
  const host = parsed.hostname;
  const blocked =
    host.includes("neon.tech") ||
    host.includes("vercel-storage") ||
    host.includes("amazonaws.com") ||
    host.includes("verthill") ||
    process.env.PRODUCTION_DATABASE_URL === url;
  if (blocked || (host !== "localhost" && host !== "127.0.0.1")) {
    throw new Error(
      `⛔ Production/원격 DB write 차단: host=${host}. localhost 테스트 DB만 허용.`
    );
  }
}

function jsonReq(
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function cookieHeaderFrom(res: Response): string {
  const cookies = res.headers.getSetCookie?.() ?? [];
  const raw = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!raw) throw new Error("vh_session cookie missing");
  return raw.split(";")[0];
}

function cookieJarFromHeader(header: string) {
  const [name, ...rest] = header.split("=");
  const value = rest.join("=");
  return {
    get(n: string) {
      return n === name ? { value } : undefined;
    },
  };
}

const ENV_CRED_KEYS = [
  "ADMIN_PASSWORD",
  "ADMIN_USER",
  "ADMIN_USERNAME",
  "CADDY_PASSWORD",
  "CADDY_USER",
  "CADDY_USERNAME",
] as const;

function snapshotEnvCreds() {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_CRED_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnvCreds(snap: Record<string, string | undefined>) {
  for (const k of ENV_CRED_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function clearEnvCreds() {
  for (const k of ENV_CRED_KEYS) delete process.env[k];
}

async function main() {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "unit-test-session-secret-32chars!!";

  section("password policy (no DB)");
  assert(isBannedTempNumericPassword("12345678") === true, "12345678 banned");
  assert(isBannedTempNumericPassword("87654321") === true, "87654321 banned");
  assert(isBannedTempNumericPassword("00000000") === true, "all zeros banned");
  assert(isBannedTempNumericPassword("11111111") === true, "all ones banned");
  assert(isBannedTempNumericPassword("01234567") === true, "ascending banned");
  assert(isBannedTempNumericPassword("76543210") === true, "descending banned");
  assert(isBannedTempNumericPassword("48291037") === false, "random 8-digit allowed");
  assert(validateNewPassword("short", "temp-pass") === "too_short", "new < 8 blocked");
  assert(
    validateNewPassword("temp-pass", "temp-pass") === "same_as_current",
    "same as current blocked"
  );
  assert(validateNewPassword("new-pass1", "temp-pass") === null, "valid new password");
  assert(
    validatePasswordConfirm("new-pass1", "new-pass2") === "confirm_mismatch",
    "confirm mismatch UI check"
  );
  assert(
    validatePasswordConfirm("new-pass1", "new-pass1") === null,
    "confirm match ok"
  );
  assert(
    newPasswordIssueMessage("too_short").includes("8"),
    "too_short message mentions 8"
  );
  assert(
    postLoginPath("admin", true) === "/change-password",
    "forced change skips /manage"
  );
  assert(postLoginPath("admin", false) === "/manage", "admin after change → /manage");
  assert(postLoginPath("caddy", false) === "/caddy", "caddy stays /caddy");
  assert(
    shouldForcePasswordChange({ userId: null, mustChangePassword: true }) ===
      false,
    "env admin (uid=null) not forced"
  );
  assert(
    shouldForcePasswordChange({ userId: 1, mustChangePassword: true }) === true,
    "DB user mustChangePassword=true forced"
  );
  assert(
    shouldForcePasswordChange({ userId: 1, mustChangePassword: false }) ===
      false,
    "existing DB user not forced"
  );

  section("temp password generator");
  const temps = generateDistinctTempNumericPasswords(12);
  assert(temps.length === 12, "12 distinct temps");
  assert(new Set(temps).size === 12, "temps unique");
  assert(
    temps.every((t) => /^\d{8}$/.test(t) && !isBannedTempNumericPassword(t)),
    "temps are non-banned 8-digit"
  );
  assert(
    temps.every((t) => !BANNED_TEMP_NUMERIC_PASSWORDS.has(t)),
    "explicit denylist avoided"
  );
  for (let i = 0; i < 20; i++) {
    const t = generateTempNumericPassword();
    if (isBannedTempNumericPassword(t) || t.length !== 8) {
      assert(false, "generator produced banned/non-8-digit value");
      break;
    }
  }
  assert(true, "20 extra generated temps passed denylist");

  section("staff username list");
  assert(STAFF_ADMIN_USERNAMES.length === 5, "5 staff names");
  assert(
    STAFF_ADMIN_USERNAMES.join(",") === "박성민,이기흥,구건호,지창욱,이성인",
    "staff names in requested order"
  );

  section("source: 직원 계정 관리는 requireAccountManager");
  const staffListSrc = fs.readFileSync(
    path.resolve("src/app/api/admin/staff-accounts/route.ts"),
    "utf8"
  );
  const staffResetSrc = fs.readFileSync(
    path.resolve("src/app/api/admin/staff-accounts/[id]/reset-password/route.ts"),
    "utf8"
  );
  const authSrc = fs.readFileSync(path.resolve("src/lib/auth.ts"), "utf8");
  const mwSrc = fs.readFileSync(path.resolve("src/middleware.ts"), "utf8");
  const manageLayoutSrc = fs.readFileSync(
    path.resolve("src/app/manage/layout.tsx"),
    "utf8"
  );
  const staffPageLayoutSrc = fs.readFileSync(
    path.resolve("src/app/manage/staff-accounts/layout.tsx"),
    "utf8"
  );
  const changePwSrc = fs.readFileSync(
    path.resolve("src/app/api/auth/change-password/route.ts"),
    "utf8"
  );
  assert(
    staffListSrc.includes("requireAccountManager") &&
      !staffListSrc.includes("requireAdmin"),
    "list API uses requireAccountManager, not requireAdmin"
  );
  assert(
    staffResetSrc.includes("requireAccountManager") &&
      !staffResetSrc.includes("requireAdmin"),
    "reset API uses requireAccountManager, not requireAdmin"
  );
  assert(
    authSrc.includes("export async function requireAccountManager") &&
      authSrc.includes("export async function requireSuperAdmin"),
    "auth exports requireAccountManager / requireSuperAdmin"
  );
  assert(
    authSrc.includes("requireAdmin") &&
      authSrc.includes("shouldForcePasswordChange"),
    "requireAdmin still used for ops + password-change gate"
  );
  assert(
    mwSrc.includes("/manage/staff-accounts") &&
      mwSrc.includes("isAccountManagerAuth"),
    "middleware blocks /manage/staff-accounts for non-super admin"
  );
  assert(
    manageLayoutSrc.includes("canManageStaffAccounts") &&
      manageLayoutSrc.includes("isAccountManagerAuth"),
    "manage layout passes account-manager flag to shell"
  );
  assert(
    staffPageLayoutSrc.includes("isAccountManagerAuth"),
    "staff-accounts layout has server-side gate"
  );
  assert(
    changePwSrc.includes("resolveAuthUser") &&
      !changePwSrc.includes("requireAccountManager"),
    "본인 change-password는 계정관리 권한과 분리"
  );

  section("최고관리자만 직원 계정 관리");
  assert(SUPER_ADMIN_USERNAME === "admin", "DB super admin username is admin");
  assert(
    isAccountManagerAuth({ role: "admin", username: "admin", userId: 1 }) === true,
    "DB username=admin can manage staff accounts"
  );
  assert(
    isAccountManagerAuth({ role: "admin", username: "env_admin", userId: null }) ===
      true,
    "env-only admin (uid null) can manage staff accounts"
  );
  for (const name of STAFF_ADMIN_USERNAMES) {
    assert(
      isAccountManagerAuth({ role: "admin", username: name, userId: 10 }) === false,
      `${name} staff admin cannot manage staff accounts`
    );
  }
  assert(
    isAccountManagerAuth({ role: "caddy", username: "admin", userId: 1 }) === false,
    "caddy role cannot manage staff accounts"
  );
  const adminNav = manageNavItems(true).map((i) => i.href);
  const staffNav = manageNavItems(false).map((i) => i.href);
  assert(adminNav.includes("/manage/staff-accounts"), "admin → 직원 계정 메뉴 보임");
  assert(
    !staffNav.includes("/manage/staff-accounts"),
    "직원 admin → 직원 계정 메뉴 안 보임"
  );
  assert(staffNav.includes("/manage/assignments"), "직원 admin 자동배치 메뉴 유지");
  assert(staffNav.includes("/manage/caddies"), "직원 admin 캐디관리 메뉴 유지");

  const staffMwReq = new NextRequest("https://example.com/manage/staff-accounts", {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${await signSessionClaims(
        buildSessionClaims({
          userId: 99,
          username: "박성민",
          role: "admin",
          sessionVersion: 1,
        })
      )}`,
    },
  });
  const staffMw = await middleware(staffMwReq);
  assert(staffMw.status === 403, "직원 admin URL 직접 입력 → 403");
  const staffMwJson = await staffMw.json();
  assert(staffMwJson.error === "forbidden", "middleware forbidden code");

  const superMwReq = new NextRequest("https://example.com/manage/staff-accounts", {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${await signSessionClaims(
        buildSessionClaims({
          userId: 1,
          username: "admin",
          role: "admin",
          sessionVersion: 1,
        })
      )}`,
    },
  });
  const superMw = await middleware(superMwReq);
  assert(superMw.status !== 403, "admin username URL 접근은 middleware 통과");

  const envMwReq = new NextRequest("https://example.com/manage/staff-accounts", {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${await signSessionClaims(
        buildSessionClaims({
          userId: null,
          username: "env_admin_staff_test",
          role: "admin",
          sessionVersion: 0,
        })
      )}`,
    },
  });
  const envMw = await middleware(envMwReq);
  assert(envMw.status !== 403, "env admin URL 접근은 middleware 통과");

  const assignMwReq = new NextRequest("https://example.com/manage/assignments", {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${await signSessionClaims(
        buildSessionClaims({
          userId: 99,
          username: "박성민",
          role: "admin",
          sessionVersion: 1,
        })
      )}`,
    },
  });
  const assignMw = await middleware(assignMwReq);
  assert(assignMw.status !== 403, "직원 admin 자동배치 경로는 403 아님");

  const caddyMwReq = new NextRequest("https://example.com/manage/staff-accounts", {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${await signSessionClaims(
        buildSessionClaims({
          userId: 8,
          username: "caddy1",
          role: "caddy",
          sessionVersion: 1,
        })
      )}`,
    },
  });
  const caddyMw = await middleware(caddyMwReq);
  assert(caddyMw.status === 307 || caddyMw.status === 302, "caddy /manage → login redirect");
  assert(
    (caddyMw.headers.get("location") || "").includes("/login"),
    "caddy role still redirected, not staff-account 403"
  );

  const envMgrReq = new NextRequest("https://example.com/api/admin/staff-accounts", {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${await signSessionClaims(
        buildSessionClaims({
          userId: null,
          username: "env_admin_staff_test",
          role: "admin",
          sessionVersion: 0,
        })
      )}`,
    },
  });
  const envMgr = await requireAccountManager(envMgrReq);
  assert(
    envMgr === undefined,
    "env-only admin requireAccountManager passes (no DB)"
  );
  const envAdminOps = await requireAdmin(envMgrReq);
  assert(envAdminOps === undefined, "env-only admin requireAdmin still passes");

  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL =
      "postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public";
  }
  assertLocalDatabaseUrl(process.env.DATABASE_URL);

  const { POST: loginPOST } = await import("../src/app/api/login/route");
  const { POST: authLoginPOST } = await import(
    "../src/app/api/auth/login/route"
  );
  const { POST: changePasswordPOST } = await import(
    "../src/app/api/auth/change-password/route"
  );
  const { GET: staffListGET } = await import(
    "../src/app/api/admin/staff-accounts/route"
  );
  const { POST: staffResetPOST } = await import(
    "../src/app/api/admin/staff-accounts/[id]/reset-password/route"
  );
  const { GET: caddiesGET } = await import("../src/app/api/caddies/route");
  const { POST: logoutPOST } = await import("../src/app/api/logout/route");

  const prisma = new PrismaClient();
  const tag = `__staff_pw_${Date.now()}`;
  const koreanUsername = `한글테스트${tag.slice(-6)}`;
  const envSnap = snapshotEnvCreds();
  clearEnvCreds();
  let createdDbSuper = false;
  let dbSuperId: number | null = null;

  try {
    const tempA = generateTempNumericPassword();
    const tempB = generateTempNumericPassword();
    const existingAdminPlain = `exAdm_${tag.slice(-6)}xx`;
    const hashA = await bcrypt.hash(tempA, 4);
    const hashExisting = await bcrypt.hash(existingAdminPlain, 4);

    const staffUser = await prisma.user.create({
      data: {
        username: koreanUsername,
        password: hashA,
        role: "admin",
        mustChangePassword: true,
        managedTeams: [],
      },
    });
    const existingAdmin = await prisma.user.create({
      data: {
        username: `${tag}_admin`,
        password: hashExisting,
        role: "admin",
        mustChangePassword: false,
        managedTeams: [],
      },
    });
    const kakaoUser = await prisma.user.create({
      data: {
        username: `kakao_${tag}`,
        password: null,
        role: "caddy",
        kakaoUserId: `kakao-test-${tag}`,
        mustChangePassword: false,
        managedTeams: [],
      },
    });

    section("한글 username 로그인 / 잘못된 임시 비밀번호");
    const badLogin = await loginPOST(
      jsonReq("https://example.com/api/login", {
        username: koreanUsername,
        password: "00000000",
      })
    );
    assert(badLogin.status === 401, "wrong temp password → 401");

    const firstLogin = await loginPOST(
      jsonReq("https://example.com/api/login", {
        username: koreanUsername,
        password: tempA,
      })
    );
    const firstJson = await firstLogin.json();
    assert(firstLogin.status === 200, "한글 username login → 200");
    assert(firstJson.role === "admin", "staff role admin");
    assert(
      firstJson.mustChangePassword === true,
      "new staff mustChangePassword=true"
    );
    const staffCookie = cookieHeaderFrom(firstLogin);

    const authLogin = await authLoginPOST(
      jsonReq("https://example.com/api/auth/login", {
        username: koreanUsername,
        password: tempA,
      })
    );
    const authLoginJson = await authLogin.json();
    assert(authLogin.status === 200, "/api/auth/login 한글 username → 200");
    assert(
      authLoginJson.mustChangePassword === true,
      "/api/auth/login surfaces mustChangePassword"
    );

    section("강제 변경 우회 차단");
    const manageApi = await caddiesGET(
      new NextRequest("https://example.com/api/caddies", {
        headers: { cookie: staffCookie },
      })
    );
    const manageApiJson = await manageApi.json();
    assert(manageApi.status === 403, "/api/caddies blocked before password change");
    assert(
      manageApiJson.error === "MUST_CHANGE_PASSWORD",
      "admin API error MUST_CHANGE_PASSWORD"
    );

    const staffListBlocked = await staffListGET(
      new NextRequest("https://example.com/api/admin/staff-accounts", {
        headers: { cookie: staffCookie },
      })
    );
    assert(
      staffListBlocked.status === 403,
      "staff-accounts API blocked before password change"
    );

    const reqAdmin = await requireAdmin(
      new NextRequest("https://example.com/api/caddies", {
        headers: { cookie: staffCookie },
      })
    );
    assert(
      reqAdmin instanceof Response && reqAdmin.status === 403,
      "requireAdmin gate 403"
    );

    const staffAuth = await resolveAuthFromCookieStore(
      cookieJarFromHeader(staffCookie)
    );
    assert(
      shouldForcePasswordChange(staffAuth) === true,
      "/manage layout would redirect to /change-password"
    );

    section("비밀번호 변경 검증");
    const wrongCurrent = await changePasswordPOST(
      jsonReq(
        "https://example.com/api/auth/change-password",
        { currentPassword: "not-the-temp", newPassword: "changed-pass-1" },
        { cookie: staffCookie }
      )
    );
    assert(wrongCurrent.status === 400, "wrong current password → 400");
    const wrongCurrentJson = await wrongCurrent.json();
    assert(
      wrongCurrentJson.error === "bad_current_password",
      "wrong current error code"
    );

    const tooShort = await changePasswordPOST(
      jsonReq(
        "https://example.com/api/auth/change-password",
        { currentPassword: tempA, newPassword: "short" },
        { cookie: staffCookie }
      )
    );
    assert(tooShort.status === 400, "new password < 8 → 400");
    const tooShortJson = await tooShort.json();
    assert(tooShortJson.error === "too_short", "too_short error code");

    const sameAsCurrent = await changePasswordPOST(
      jsonReq(
        "https://example.com/api/auth/change-password",
        { currentPassword: tempA, newPassword: tempA },
        { cookie: staffCookie }
      )
    );
    assert(sameAsCurrent.status === 400, "new === current → 400");

    const otherIdAttempt = await changePasswordPOST(
      jsonReq(
        "https://example.com/api/auth/change-password",
        {
          currentPassword: tempA,
          newPassword: "changed-pass-1",
          userId: existingAdmin.id,
          username: existingAdmin.username,
        },
        { cookie: staffCookie }
      )
    );
    assert(otherIdAttempt.status === 200, "extra userId field ignored; self change ok");
    const changedJson = await otherIdAttempt.json();
    assert(changedJson.ok === true, "change-password ok");
    assert(
      changedJson.mustChangePassword === false,
      "mustChangePassword=false after change"
    );
    const changedCookie = cookieHeaderFrom(otherIdAttempt);

    const otherStill = await prisma.user.findUnique({
      where: { id: existingAdmin.id },
      select: { password: true, mustChangePassword: true, sessionVersion: true },
    });
    assert(
      otherStill?.mustChangePassword === false &&
        (await verifyUserPassword(existingAdminPlain, otherStill.password)),
      "cannot change another user's password via this API"
    );

    const selfAfter = await prisma.user.findUnique({
      where: { id: staffUser.id },
      select: { mustChangePassword: true, sessionVersion: true, password: true },
    });
    assert(selfAfter?.mustChangePassword === false, "DB flag cleared");
    assert(
      (selfAfter?.sessionVersion ?? 0) === staffUser.sessionVersion + 1,
      "sessionVersion incremented on change"
    );
    assert(
      (await verifyUserPassword("changed-pass-1", selfAfter?.password)) === true,
      "new password hash stored"
    );

    const oldSession = await resolveAuthFromCookieStore(
      cookieJarFromHeader(staffCookie)
    );
    assert(oldSession === null, "pre-change session invalidated");

    section("변경 후 관리자 화면 / 재로그인");
    const manageOk = await caddiesGET(
      new NextRequest("https://example.com/api/caddies", {
        headers: { cookie: changedCookie },
      })
    );
    assert(manageOk.status === 200, "after change, admin API allowed");

    const oldTempLogin = await loginPOST(
      jsonReq("https://example.com/api/login", {
        username: koreanUsername,
        password: tempA,
      })
    );
    assert(oldTempLogin.status === 401, "old temp password login fails");

    const newLogin = await loginPOST(
      jsonReq("https://example.com/api/login", {
        username: koreanUsername,
        password: "changed-pass-1",
      })
    );
    const newLoginJson = await newLogin.json();
    assert(newLogin.status === 200, "new password re-login ok");
    assert(
      newLoginJson.mustChangePassword === false,
      "re-login not forced after change"
    );
    const newLoginCookie = cookieHeaderFrom(newLogin);

    section("직원 admin은 직원 계정 API 차단, 운영 API는 유지");
    const staffListForbidden = await staffListGET(
      new NextRequest("https://example.com/api/admin/staff-accounts", {
        headers: { cookie: newLoginCookie },
      })
    );
    const staffListForbiddenJson = await staffListForbidden.json();
    assert(staffListForbidden.status === 403, "직원 admin list API → 403");
    assert(
      staffListForbiddenJson.error === "forbidden",
      "직원 admin list forbidden"
    );
    const staffResetForbidden = await staffResetPOST(
      jsonReq(
        `https://example.com/api/admin/staff-accounts/${staffUser.id}/reset-password`,
        {},
        { cookie: newLoginCookie }
      ),
      { params: { id: String(staffUser.id) } }
    );
    assert(staffResetForbidden.status === 403, "직원 admin reset API → 403");
    const staffOps = await caddiesGET(
      new NextRequest("https://example.com/api/caddies", {
        headers: { cookie: newLoginCookie },
      })
    );
    assert(staffOps.status === 200, "직원 admin 캐디관리 API 정상");
    const staffMgrGate = await requireAccountManager(
      new NextRequest("https://example.com/api/admin/staff-accounts", {
        headers: { cookie: newLoginCookie },
      })
    );
    assert(
      staffMgrGate instanceof Response && staffMgrGate.status === 403,
      "requireAccountManager 직원 admin → 403"
    );
    const staffOpsGate = await requireAdmin(
      new NextRequest("https://example.com/api/caddies", {
        headers: { cookie: newLoginCookie },
      })
    );
    assert(staffOpsGate === undefined, "requireAdmin 직원 admin 운영 API 통과");

    section("기존 DB admin / env admin 회귀");
    const existingLogin = await loginPOST(
      jsonReq("https://example.com/api/login", {
        username: existingAdmin.username,
        password: existingAdminPlain,
      })
    );
    const existingLoginJson = await existingLogin.json();
    assert(existingLogin.status === 200, "existing DB admin login ok");
    assert(
      existingLoginJson.mustChangePassword === false,
      "existing DB admin not forced"
    );
    const existingCookie = cookieHeaderFrom(existingLogin);
    const existingManage = await caddiesGET(
      new NextRequest("https://example.com/api/caddies", {
        headers: { cookie: existingCookie },
      })
    );
    assert(existingManage.status === 200, "existing DB admin API ok");

    process.env.ADMIN_PASSWORD = "env-admin-pass-not-default";
    process.env.ADMIN_USER = "env_admin_staff_test";
    const envLogin = await loginPOST(
      jsonReq("https://example.com/api/login", {
        username: "env_admin_staff_test",
        password: "env-admin-pass-not-default",
      })
    );
    const envLoginJson = await envLogin.json();
    assert(envLogin.status === 200, "env admin login ok");
    assert(
      envLoginJson.mustChangePassword === false,
      "env admin mustChangePassword false"
    );
    const envCookie = cookieHeaderFrom(envLogin);
    const envManage = await caddiesGET(
      new NextRequest("https://example.com/api/caddies", {
        headers: { cookie: envCookie },
      })
    );
    assert(envManage.status === 200, "env admin API ok");

    const envChange = await changePasswordPOST(
      jsonReq(
        "https://example.com/api/auth/change-password",
        { currentPassword: "env-admin-pass-not-default", newPassword: "xxxxxxxx" },
        { cookie: envCookie }
      )
    );
    assert(envChange.status === 400, "env admin cannot use change-password API");

    section("admin reset");
    const otherAdminList = await staffListGET(
      new NextRequest("https://example.com/api/admin/staff-accounts", {
        headers: { cookie: existingCookie },
      })
    );
    assert(
      otherAdminList.status === 403,
      "non-super DB admin cannot list staff accounts"
    );
    const listRes = await staffListGET(
      new NextRequest("https://example.com/api/admin/staff-accounts", {
        headers: { cookie: envCookie },
      })
    );
    const listJson = await listRes.json();
    assert(listRes.status === 200, "staff list ok for env/super admin");
    const envMgrGate = await requireAccountManager(
      new NextRequest("https://example.com/api/admin/staff-accounts", {
        headers: { cookie: envCookie },
      })
    );
    assert(envMgrGate === undefined, "requireAccountManager env admin 통과");

    let dbSuper = await prisma.user.findUnique({
      where: { username: SUPER_ADMIN_USERNAME },
      select: { id: true, username: true, sessionVersion: true },
    });
    if (!dbSuper) {
      dbSuper = await prisma.user.create({
        data: {
          username: SUPER_ADMIN_USERNAME,
          password: hashExisting,
          role: "admin",
          mustChangePassword: false,
          managedTeams: [],
        },
        select: { id: true, username: true, sessionVersion: true },
      });
      createdDbSuper = true;
    }
    dbSuperId = dbSuper.id;
    const dbSuperCookie = `${SESSION_COOKIE_NAME}=${await signSessionClaims(
      buildSessionClaims({
        userId: dbSuper.id,
        username: dbSuper.username,
        role: "admin",
        sessionVersion: dbSuper.sessionVersion,
      })
    )}`;
    const dbSuperList = await staffListGET(
      new NextRequest("https://example.com/api/admin/staff-accounts", {
        headers: { cookie: dbSuperCookie },
      })
    );
    assert(dbSuperList.status === 200, "DB username=admin → 직원 계정 목록 200");
    const dbSuperMgr = await requireAccountManager(
      new NextRequest("https://example.com/api/admin/staff-accounts", {
        headers: { cookie: dbSuperCookie },
      })
    );
    assert(dbSuperMgr === undefined, "DB username=admin requireAccountManager 통과");
    const listed = (listJson.users as Array<{ id: number; username: string }>) || [];
    assert(
      listed.some((u) => u.id === staffUser.id),
      "password staff listed"
    );
    assert(
      listed.every((u) => u.username !== kakaoUser.username),
      "kakao user not mixed into staff list"
    );
    const listBlob = JSON.stringify(listJson);
    assert(!listBlob.includes("$2"), "staff list does not expose password hash");
    assert(
      !("password" in (listJson.users?.[0] || {})),
      "staff list has no password field"
    );

    const staffAdminCannotReset = await staffResetPOST(
      jsonReq(
        `https://example.com/api/admin/staff-accounts/${staffUser.id}/reset-password`,
        {},
        { cookie: existingCookie }
      ),
      { params: { id: String(staffUser.id) } }
    );
    assert(
      staffAdminCannotReset.status === 403,
      "기존 직원 admin reset API 직접 호출 → 403"
    );

    const dbSuperReset = await staffResetPOST(
      jsonReq(
        `https://example.com/api/admin/staff-accounts/${existingAdmin.id}/reset-password`,
        {},
        { cookie: dbSuperCookie }
      ),
      { params: { id: String(existingAdmin.id) } }
    );
    const dbSuperResetJson = await dbSuperReset.json();
    assert(dbSuperReset.status === 200, "DB username=admin → 임시 비밀번호 reset 가능");
    assert(dbSuperResetJson.ok === true, "DB admin reset ok=true");
    assert(
      /^\d{8}$/.test(String(dbSuperResetJson.temporaryPassword || "")),
      "DB admin reset returns 8-digit temp once"
    );

    const svBefore = await prisma.user.findUnique({
      where: { id: staffUser.id },
      select: { sessionVersion: true },
    });
    const resetRes = await staffResetPOST(
      jsonReq(
        `https://example.com/api/admin/staff-accounts/${staffUser.id}/reset-password`,
        {},
        { cookie: envCookie }
      ),
      { params: { id: String(staffUser.id) } }
    );
    const resetJson = await resetRes.json();
    assert(resetRes.status === 200, "admin reset ok");
    assert(resetJson.ok === true, "reset ok=true");
    const resetTemp = String(resetJson.temporaryPassword || "");
    assert(/^\d{8}$/.test(resetTemp), "reset returns 8-digit temp once");
    assert(
      !isBannedTempNumericPassword(resetTemp),
      "reset temp is not a banned pattern"
    );
    assert(
      resetJson.user?.mustChangePassword === true,
      "reset sets mustChangePassword true"
    );
    const resetBlob = JSON.stringify(resetJson);
    assert(!resetBlob.includes("$2"), "reset response has no password hash");
    assert(!("password" in (resetJson.user || {})), "reset user has no hash field");

    const afterReset = await prisma.user.findUnique({
      where: { id: staffUser.id },
      select: { mustChangePassword: true, sessionVersion: true, password: true },
    });
    assert(afterReset?.mustChangePassword === true, "DB mustChangePassword=true");
    assert(
      (afterReset?.sessionVersion ?? 0) === (svBefore?.sessionVersion ?? 0) + 1,
      "reset increments sessionVersion"
    );

    const staleAfterReset = await resolveAuthFromCookieStore(
      cookieJarFromHeader(newLoginCookie)
    );
    assert(staleAfterReset === null, "old session invalid after reset");

    const resetKakao = await staffResetPOST(
      jsonReq(
        `https://example.com/api/admin/staff-accounts/${kakaoUser.id}/reset-password`,
        {},
        { cookie: envCookie }
      ),
      { params: { id: String(kakaoUser.id) } }
    );
    assert(resetKakao.status === 404, "kakao-only user reset rejected");

    const afterResetLogin = await loginPOST(
      jsonReq("https://example.com/api/login", {
        username: koreanUsername,
        password: resetTemp,
      })
    );
    const afterResetLoginJson = await afterResetLogin.json();
    assert(afterResetLogin.status === 200, "new temp password login ok");
    assert(
      afterResetLoginJson.mustChangePassword === true,
      "reset login is forced to change again"
    );
    const afterResetCookie = cookieHeaderFrom(afterResetLogin);
    const blockedAgain = await caddiesGET(
      new NextRequest("https://example.com/api/caddies", {
        headers: { cookie: afterResetCookie },
      })
    );
    assert(blockedAgain.status === 403, "admin API blocked again after reset");

    const changedAfterReset = await changePasswordPOST(
      jsonReq(
        "https://example.com/api/auth/change-password",
        { currentPassword: resetTemp, newPassword: "changed-pass-2" },
        { cookie: afterResetCookie }
      )
    );
    assert(changedAfterReset.status === 200, "forced change after reset succeeds");

    const logoutRes = await logoutPOST(
      new NextRequest("https://example.com/api/logout", {
        method: "POST",
        headers: { cookie: afterResetCookie },
      })
    );
    assert(logoutRes.status === 200, "logout still works");

    // unused generated temp kept out of logs; touch tempB so uniqueness path is used
    assert(tempB !== tempA, "generated temps for two users differ");
  } catch (e: any) {
    assert(false, `staff admin DB tests failed: ${e?.message || e}`);
    console.error(e);
  } finally {
    restoreEnvCreds(envSnap);
    if (createdDbSuper && dbSuperId != null) {
      await prisma.user.delete({ where: { id: dbSuperId } }).catch(() => {});
    }
    await prisma.user.deleteMany({
      where: {
        OR: [
          { username: { startsWith: tag } },
          { username: { startsWith: "한글테스트" } },
          { username: { startsWith: `kakao_${tag}` } },
        ],
      },
    });
    await prisma.$disconnect();
  }

  if (prevSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = prevSecret;

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
