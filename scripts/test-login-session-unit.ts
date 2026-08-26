/**
 * 로그인 세션 유틸 단위 테스트 (DB 없음 — signed cookie + version 규칙)
 * 실행: npx tsx scripts/test-login-session-unit.ts
 */
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  applySessionCookies,
  buildSessionClaims,
  clearSessionCookies,
  getVerifiedSessionFromCookies,
  isHttpsRequest,
  normalizeAppRole,
  signSessionClaims,
  verifySignedSessionToken,
} from "../src/lib/sessionCookies";
import {
  hasPasswordHash,
  verifyUserPassword,
} from "../src/lib/userPassword";
import { requireAdmin, resolveAuthFromCookieStore } from "../src/lib/auth";
import {
  getEnvOnlyAdmin,
  getEnvOnlyCaddy,
  matchEnvOnlyAccount,
} from "../src/lib/envCredentials";
import {
  passwordLogin,
  type PasswordLoginDb,
  type PasswordLoginUser,
} from "../src/lib/passwordLogin";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";

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

function cookieJar(map: Record<string, string>) {
  return {
    get(name: string) {
      return map[name] ? { value: map[name] } : undefined;
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

function mockDb(row: PasswordLoginUser | null | "throw"): PasswordLoginDb {
  return {
    user: {
      async findUnique() {
        if (row === "throw") {
          const err = new Error("db schema mismatch");
          (err as any).code = "P2022";
          throw err;
        }
        return row;
      },
    },
  };
}

function jsonReq(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function walkSourceFiles(dir: string, acc: string[] = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSourceFiles(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(ent.name)) acc.push(p);
  }
  return acc;
}

async function main() {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "unit-test-session-secret-32chars!!";

  console.log("== normalizeAppRole ==");
  assert(normalizeAppRole("admin") === "admin", "admin");
  assert(normalizeAppRole("ADMIN") === "admin", "ADMIN→admin");
  assert(normalizeAppRole("caddy") === "caddy", "caddy");
  assert(normalizeAppRole("STAFF") === "caddy", "STAFF→caddy");
  assert(normalizeAppRole("leader") === "leader", "leader");
  assert(normalizeAppRole("nope") === null, "unknown null");

  console.log("== isHttpsRequest ==");
  const prevVercel = process.env.VERCEL;
  delete process.env.VERCEL;
  assert(
    isHttpsRequest(fakeReq("https://caddy-system.vercel.app/api/login")) === true,
    "https url"
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

  console.log("== signed session ==");
  const claims = buildSessionClaims({
    userId: 42,
    username: "admin_user",
    role: "admin",
    sessionVersion: 3,
    nowSec: 1_700_000_000,
  });
  const token = await signSessionClaims(claims);
  const ok = await verifySignedSessionToken(token, { nowSec: 1_700_000_100 });
  assert(!!ok && ok.uid === 42 && ok.sv === 3 && ok.role === "admin", "sign/verify ok");

  const badSig = token.slice(0, -4) + "xxxx";
  assert(
    (await verifySignedSessionToken(badSig, { nowSec: 1_700_000_100 })) === null,
    "signature tamper → reject"
  );

  const roleTamper = await signSessionClaims({
    ...claims,
    role: "caddy",
  });
  // forge by rewriting body without valid sig already covered; also claim role caddy can't be admin
  const forgedRoleBody = token; // use valid caddy session for requireAdmin
  const caddyTok = await signSessionClaims(
    buildSessionClaims({
      userId: 7,
      username: "caddy1",
      role: "caddy",
      sessionVersion: 0,
    })
  );
  const caddyReq = new NextRequest("http://localhost/api/users", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${caddyTok}` },
  });
  // env account path: uid null — requireAdmin uses resolveAuth without DB
  const guardCaddy = await requireAdmin(caddyReq);
  assert(
    guardCaddy instanceof Response && guardCaddy.status === 401,
    "role=caddy cannot gain admin"
  );

  // username/id mismatch would need DB — covered by resolveAuthFromCookieStore unit with mock below via verify only
  const uidTamperClaims = buildSessionClaims({
    userId: 99,
    username: "admin_user",
    role: "admin",
    sessionVersion: 3,
  });
  const uidTok = await signSessionClaims(uidTamperClaims);
  assert(
    (await verifySignedSessionToken(uidTok))?.uid === 99,
    "valid token parses uid (DB mismatch checked in resolveAuth)"
  );

  console.log("== legacy unsigned rejected ==");
  const legacyOnly = cookieJar({
    role: "admin",
    session_role: "admin",
    session_user: "admin",
    admin: "1",
  });
  assert(
    (await getVerifiedSessionFromCookies(legacyOnly)) === null,
    "unsigned legacy cookies alone → not authenticated"
  );
  const legacyReq = new NextRequest("http://localhost/api/caddies", {
    headers: { cookie: "role=admin; session_user=admin; admin=1" },
  });
  const legacyGuard = await requireAdmin(legacyReq);
  assert(
    legacyGuard instanceof Response && legacyGuard.status === 401,
    "legacy-only requireAdmin → 401"
  );

  console.log("== applySessionCookies clears legacy ==");
  const res = NextResponse.json({ ok: true });
  await applySessionCookies(res, fakeReq("https://example.com/api/login"), {
    userId: 1,
    username: "u1",
    role: "admin",
    sessionVersion: 0,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const blob = setCookie.join("\n");
  assert(blob.includes(`${SESSION_COOKIE_NAME}=`), "sets vh_session");
  assert(
    /(?:^|\n)role=;/.test(blob) || blob.includes("role=;"),
    "clears legacy role cookie"
  );

  console.log("== sessionVersion mismatch (resolve without prisma row) ==");
  // env session sv=0 always "matches" for uid null
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
  assert(envAuth?.role === "admin" && envAuth.userId == null && envAuth.mustChangePassword === false, "env signed admin ok");

  console.log("== logout clears cookies ==");
  const out = NextResponse.json({ ok: true });
  clearSessionCookies(out, fakeReq("https://example.com/"));
  const cleared = (out.headers.getSetCookie?.() ?? []).join("\n");
  assert(cleared.includes(`${SESSION_COOKIE_NAME}=`), "clears vh_session");

  console.log("== verifyUserPassword null-safe ==");
  assert(hasPasswordHash(null) === false, "null hash rejected");
  assert((await verifyUserPassword("x", null)) === false, "null password → false");
  const h = await bcrypt.hash("pw", 10);
  assert((await verifyUserPassword("pw", h)) === true, "hash login ok");
  assert((await verifyUserPassword("no", h)) === false, "bad password");

  console.log("== no source default passwords in runtime src ==");
  {
    const banned = ["caddy1234", "admin1234", "011697"];
    const files = walkSourceFiles(path.resolve("src"));
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const needle of banned) {
        if (text.includes(needle)) hits.push(`${path.relative(".", file)}:${needle}`);
      }
    }
    assert(hits.length === 0, `no hardcoded default passwords in src (${hits.join(",") || "none"})`);
  }

  console.log("== env-only credentials (no source fallback) ==");
  {
    const snap = snapshotEnvCreds();
    try {
      clearEnvCreds();
      assert(getEnvOnlyAdmin() === null, "ADMIN_PASSWORD unset → env admin disabled");
      assert(getEnvOnlyCaddy() === null, "CADDY_PASSWORD unset → env caddy disabled");
      assert(
        matchEnvOnlyAccount("caddy", "caddy1234") === null,
        "source default caddy password does not match when env unset"
      );
      assert(
        matchEnvOnlyAccount("admin", "admin1234") === null,
        "source default admin password does not match when env unset"
      );
      assert(
        matchEnvOnlyAccount("admin", "011697") === null,
        "legacy create-admin default does not match when env unset"
      );

      const unsetCaddy = await passwordLogin("caddy", "caddy1234", mockDb(null));
      assert(unsetCaddy.status === "unauthorized", "unset env + caddy1234 → 401 path");
      const unsetAdmin = await passwordLogin("admin", "admin1234", mockDb(null));
      assert(unsetAdmin.status === "unauthorized", "unset env + admin1234 → 401 path");

      process.env.ADMIN_PASSWORD = "test-admin-pass-not-default";
      process.env.ADMIN_USER = "env_admin_test";
      process.env.CADDY_PASSWORD = "test-caddy-pass-not-default";
      process.env.CADDY_USER = "env_caddy_test";

      assert(getEnvOnlyAdmin()?.username === "env_admin_test", "env admin enabled when password set");
      assert(getEnvOnlyCaddy()?.username === "env_caddy_test", "env caddy enabled when password set");
      assert(
        matchEnvOnlyAccount("env_admin_test", "test-admin-pass-not-default")?.role === "admin",
        "injected env admin matches"
      );
      assert(
        matchEnvOnlyAccount("env_caddy_test", "test-caddy-pass-not-default")?.role === "caddy",
        "injected env caddy matches"
      );
      assert(
        matchEnvOnlyAccount("env_admin_test", "admin1234") === null,
        "injected env admin rejects old default password"
      );
      assert(
        matchEnvOnlyAccount("caddy", "caddy1234") === null,
        "injected env caddy username is not the source default id"
      );

      const envOk = await passwordLogin(
        "env_admin_test",
        "test-admin-pass-not-default",
        mockDb("throw")
      );
      assert(
        envOk.status === "ok" &&
          envOk.source === "env" &&
          envOk.userId === null &&
          envOk.mustChangePassword === false,
        "injected env admin login succeeds without DB"
      );
      const envCaddyOk = await passwordLogin(
        "env_caddy_test",
        "test-caddy-pass-not-default",
        mockDb("throw")
      );
      assert(
        envCaddyOk.status === "ok" && envCaddyOk.role === "caddy",
        "injected env caddy login succeeds without DB"
      );
    } finally {
      restoreEnvCreds(snap);
    }
  }

  console.log("== passwordLogin 401 vs 500 ==");
  {
    const snap = snapshotEnvCreds();
    try {
      clearEnvCreds();
      const missing = await passwordLogin("no_such_user", "x", mockDb(null));
      assert(missing.status === "unauthorized", "unknown user → unauthorized");
      const hash = await bcrypt.hash("correct-db-pw", 4);
      const row: PasswordLoginUser = {
        id: 42,
        username: "db_admin_user",
        password: hash,
        role: "admin",
        sessionVersion: 2,
      };
      const dbOk = await passwordLogin("db_admin_user", "correct-db-pw", mockDb(row));
      assert(
        dbOk.status === "ok" &&
          dbOk.source === "db" &&
          dbOk.userId === 42 &&
          dbOk.sessionVersion === 2 &&
          dbOk.mustChangePassword === false,
        "DB User normal login"
      );
      const mcpRow: PasswordLoginUser = {
        ...row,
        mustChangePassword: true,
      };
      const mcpOk = await passwordLogin(
        "db_admin_user",
        "correct-db-pw",
        mockDb(mcpRow)
      );
      assert(
        mcpOk.status === "ok" && mcpOk.mustChangePassword === true,
        "DB User mustChangePassword=true is returned (not dropped)"
      );
      const dbBad = await passwordLogin("db_admin_user", "wrong-pw", mockDb(row));
      assert(dbBad.status === "unauthorized", "wrong DB password → unauthorized");
      const schema = await passwordLogin("anyone", "x", mockDb("throw"));
      assert(schema.status === "unavailable", "schema/DB error → unavailable (500)");
    } finally {
      restoreEnvCreds(snap);
    }
  }

  console.log("== login routes: defaults fail, env inject succeeds ==");
  {
    const snap = snapshotEnvCreds();
    const prevDbUrl = process.env.DATABASE_URL;
    try {
      if (!process.env.DATABASE_URL) {
        process.env.DATABASE_URL =
          "postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public";
      }
      assertLocalDatabaseUrl(process.env.DATABASE_URL);
      clearEnvCreds();
      const { POST: authLoginPOST } = await import("../src/app/api/auth/login/route");
      const { POST: loginPOST } = await import("../src/app/api/login/route");
      const { POST: adminLoginPOST } = await import("../src/app/api/admin/login/route");

      const r1 = await authLoginPOST(
        jsonReq("http://localhost/api/auth/login", {
          username: "caddy",
          password: "caddy1234",
        })
      );
      assert(r1.status === 401, "/api/auth/login source default caddy → 401");
      const r2 = await authLoginPOST(
        jsonReq("http://localhost/api/auth/login", {
          username: "admin",
          password: "admin1234",
        })
      );
      assert(r2.status === 401, "/api/auth/login source default admin → 401");
      const r3 = await loginPOST(
        jsonReq("http://localhost/api/login", {
          username: "caddy",
          password: "caddy1234",
        })
      );
      assert(r3.status === 401, "/api/login source default caddy → 401");
      const r4 = await adminLoginPOST(
        jsonReq("http://localhost/api/admin/login", { password: "admin1234" })
      );
      assert(r4.status === 401, "/api/admin/login source default → 401");

      const unknown = await authLoginPOST(
        jsonReq("http://localhost/api/auth/login", {
          username: "pr48_no_such_user",
          password: "x",
        })
      );
      assert(unknown.status === 401, "unknown user → 401 (not 500) on local schema");
      const unknownJson = await unknown.json();
      assert(unknownJson.ok === false, "unknown user 401 body ok=false");

      process.env.ADMIN_PASSWORD = "test-admin-pass-not-default";
      process.env.ADMIN_USER = "env_admin_test";
      process.env.CADDY_PASSWORD = "test-caddy-pass-not-default";
      process.env.CADDY_USER = "env_caddy_test";

      const envAdmin = await authLoginPOST(
        jsonReq("https://example.com/api/auth/login", {
          username: "env_admin_test",
          password: "test-admin-pass-not-default",
        })
      );
      assert(envAdmin.status === 200, "injected env admin /api/auth/login → 200");
      const envAdminJson = await envAdmin.json();
      assert(envAdminJson.ok === true && envAdminJson.role === "admin", "env admin role");
      assert(
        envAdminJson.mustChangePassword === false,
        "env admin mustChangePassword false"
      );
      const envCookies = (envAdmin.headers.getSetCookie?.() ?? []).join("\n");
      assert(envCookies.includes(`${SESSION_COOKIE_NAME}=`), "env admin sets vh_session");

      const envCaddy = await loginPOST(
        jsonReq("https://example.com/api/login", {
          username: "env_caddy_test",
          password: "test-caddy-pass-not-default",
        })
      );
      assert(envCaddy.status === 200, "injected env caddy /api/login → 200");
      const envCaddyJson = await envCaddy.json();
      assert(envCaddyJson.ok === true && envCaddyJson.role === "caddy", "env caddy role");

      const oldStillFails = await authLoginPOST(
        jsonReq("http://localhost/api/auth/login", {
          username: "caddy",
          password: "caddy1234",
        })
      );
      assert(oldStillFails.status === 401, "old default still fails after env inject");
    } finally {
      restoreEnvCreds(snap);
      if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDbUrl;
    }
  }

  console.log("== sessionVersion DB (local) ==");
  try {
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL =
        "postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public";
    }
    assertLocalDatabaseUrl(process.env.DATABASE_URL);
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const tag = `__sv_unit_${Date.now()}`;
    try {
      const user = await prisma.user.create({
        data: {
          username: tag,
          password: null,
          role: "admin",
          sessionVersion: 0,
          managedTeams: [],
        },
      });
      const tok0 = await signSessionClaims(
        buildSessionClaims({
          userId: user.id,
          username: user.username,
          role: "admin",
          sessionVersion: 0,
        })
      );
      const a0 = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tok0 })
      );
      assert(!!a0 && a0.userId === user.id, "sv=0 cookie authenticates");

      await prisma.user.update({
        where: { id: user.id },
        data: { sessionVersion: { increment: 1 } },
      });
      const a1 = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tok0 })
      );
      assert(a1 === null, "after version bump old cookie rejected");

      const other = await prisma.user.create({
        data: {
          username: tag + "_o",
          password: null,
          role: "caddy",
          sessionVersion: 9,
          managedTeams: [],
        },
      });
      const oTok = await signSessionClaims(
        buildSessionClaims({
          userId: other.id,
          username: other.username,
          role: "caddy",
          sessionVersion: 9,
        })
      );
      await prisma.user.update({
        where: { id: user.id },
        data: { sessionVersion: { increment: 1 } },
      });
      const oOk = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: oTok })
      );
      assert(!!oOk && oOk.userId === other.id, "other user session unaffected");

      const loginUser = `${tag}_pw`;
      const loginPlain = "db-user-login-pw";
      const loginHash = await bcrypt.hash(loginPlain, 4);
      await prisma.user.create({
        data: {
          username: loginUser,
          password: loginHash,
          role: "admin",
          sessionVersion: 3,
          managedTeams: [],
        },
      });
      const snap = snapshotEnvCreds();
      clearEnvCreds();
      try {
        const { POST: authLoginPOST } = await import(
          "../src/app/api/auth/login/route"
        );
        const { POST: loginPOST } = await import("../src/app/api/login/route");
        const dbLogin = await authLoginPOST(
          jsonReq("https://example.com/api/auth/login", {
            username: loginUser,
            password: loginPlain,
          })
        );
        assert(dbLogin.status === 200, "DB User /api/auth/login → 200");
        const dbLoginJson = await dbLogin.json();
        assert(dbLoginJson.ok === true && dbLoginJson.role === "admin", "DB User role admin");
        assert(
          dbLoginJson.mustChangePassword === false,
          "existing DB admin mustChangePassword false"
        );
        const dbCookies = (dbLogin.headers.getSetCookie?.() ?? []).join("\n");
        assert(dbCookies.includes(`${SESSION_COOKIE_NAME}=`), "DB User sets vh_session");

        const dbLogin2 = await loginPOST(
          jsonReq("https://example.com/api/login", {
            username: loginUser,
            password: loginPlain,
          })
        );
        assert(dbLogin2.status === 200, "DB User /api/login → 200");

        const dbWrong = await authLoginPOST(
          jsonReq("https://example.com/api/auth/login", {
            username: loginUser,
            password: "wrong-password",
          })
        );
        assert(dbWrong.status === 401, "DB User wrong password → 401");
      } finally {
        restoreEnvCreds(snap);
      }
    } finally {
      await prisma.user.deleteMany({ where: { username: { startsWith: tag } } });
      await prisma.$disconnect();
    }
  } catch (e: any) {
    assert(false, `sessionVersion DB tests failed: ${e?.message || e}`);
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
