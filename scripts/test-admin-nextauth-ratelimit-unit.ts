/**
 * Admin env-password + NextAuth credentials brute-force close.
 * local caddy_local only. No production write.
 * 실행: npm run test:admin-nextauth-ratelimit-unit
 */
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/prisma";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  PASSWORD_LOGIN_FAIL_MESSAGE,
  PASSWORD_LOGIN_RATE_MESSAGE,
} from "../src/lib/passwordLoginHttp";
import {
  ADMIN_ENV_PASSWORD_RATE_ACTION,
  ADMIN_ENV_PASSWORD_RATE_LIMIT,
  ADMIN_ENV_PASSWORD_RATE_POLICY,
  ADMIN_ENV_PASSWORD_RATE_USERNAME,
  ADMIN_ENV_PASSWORD_RATE_WINDOW_MS,
  PASSWORD_LOGIN_RATE_ACTION,
  PASSWORD_LOGIN_RATE_ENTITY,
  PASSWORD_LOGIN_RATE_LIMIT,
  claimPasswordLoginAttempt,
  loginRateIpFromAuthHeaders,
  readPasswordLoginRateLimit,
  recordPasswordLoginFailure,
  type PasswordLoginRateDb,
} from "../src/lib/passwordLoginRateLimit";
import { authorizePasswordCredentials } from "../src/lib/nextAuthCredentials";

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

function jsonReq(url: string, body: unknown, ip?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (ip) headers["x-forwarded-for"] = ip;
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

type MockRow = { id: number; ip: string; u: string; action: string; createdAt: Date };

function mockRateDb(opts?: {
  failCreate?: boolean;
}): PasswordLoginRateDb & { rows: MockRow[] } {
  const rows: MockRow[] = [];
  let nextId = 1;
  return {
    rows,
    audit: {
      async count({ where }) {
        const since = where.createdAt.gte;
        return rows.filter(
          (r) =>
            r.action === where.action &&
            r.ip === where.ip &&
            r.u === where.payload.equals.u &&
            r.createdAt >= since
        ).length;
      },
      async findFirst({ where }) {
        const since = where.createdAt.gte;
        const hit = rows
          .filter(
            (r) =>
              r.action === where.action &&
              r.ip === where.ip &&
              r.u === where.payload.equals.u &&
              r.createdAt >= since
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        return hit ? { createdAt: hit.createdAt } : null;
      },
      async create({ data }) {
        if (opts?.failCreate) throw new Error("create down");
        const row = {
          id: nextId++,
          ip: data.ip,
          u: data.payload.u,
          action: data.action,
          createdAt: new Date(),
        };
        rows.push(row);
        return { id: row.id };
      },
      async deleteMany({ where }) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if ("id" in where) {
            if (rows[i].id === where.id) rows.splice(i, 1);
          } else if (
            rows[i].ip === where.ip &&
            rows[i].u === where.payload.equals.u &&
            rows[i].action === where.action
          ) {
            rows.splice(i, 1);
          }
        }
        return { count: before - rows.length };
      },
    },
  };
}

async function main() {
  section("source: three surfaces + no C6/C7 rewrite");
  {
    const admin = read("src/app/api/admin/route.ts");
    const adminLogin = read("src/app/api/admin/login/route.ts");
    const helper = read("src/lib/adminEnvPasswordLogin.ts");
    const nextauth = read("src/app/api/auth/[...nextauth]/route.ts");
    const creds = read("src/lib/nextAuthCredentials.ts");
    const login = read("src/app/api/login/route.ts");
    const authLogin = read("src/app/api/auth/login/route.ts");
    const kakao = read("src/app/api/auth/kakao/callback/route.ts");
    assert(admin.includes("postAdminEnvPasswordLogin"), "/api/admin uses shared helper");
    assert(adminLogin.includes("postAdminEnvPasswordLogin"), "/api/admin/login uses shared helper");
    assert(admin.includes("DELETE"), "/api/admin logout DELETE kept");
    assert(helper.includes("claimPasswordLoginAttempt"), "admin claim-first");
    assert(helper.includes("ADMIN_ENV_PASSWORD_RATE_POLICY"), "admin uses IP-only policy");
    assert(helper.includes("passwordLoginUnauthorizedResponse"), "admin generic 401");
    assert(!helper.includes("INVALID_PASSWORD"), "admin no INVALID_PASSWORD");
    assert(!helper.includes("비밀번호가 올바르지 않습니다."), "admin no password-wrong copy");
    assert(!helper.includes("payload:"), "admin helper writes no Audit payload");
    assert(nextauth.includes("authorizePasswordCredentials"), "nextauth wires helper");
    assert(creds.includes("claimPasswordLoginAttempt"), "nextauth claim-first");
    assert(creds.includes("if (claim.limited) return null"), "nextauth limited is generic null");
    assert(login.includes("claimPasswordLoginAttempt"), "C7 /api/login still claim-first");
    assert(authLogin.includes("claimPasswordLoginAttempt"), "C7 /api/auth/login still claim-first");
    assert(kakao.includes("findOrCreateKakaoSessionUser"), "Kakao callback untouched");
    assert(ADMIN_ENV_PASSWORD_RATE_LIMIT === 20, "admin threshold 20");
    assert(ADMIN_ENV_PASSWORD_RATE_WINDOW_MS === 15 * 60 * 1000, "admin window 15 min");
    assert(ADMIN_ENV_PASSWORD_RATE_ACTION === "ADMIN_ENV_PASSWORD_FAIL", "admin Audit action");
    const schema = read("prisma/schema.prisma");
    assert(schema.includes("model Audit"), "reuses Audit");
    const migs = fs.readdirSync(path.resolve("prisma/migrations"));
    assert(
      !migs.some((n) => /admin.?env|nextauth.?rate/i.test(n)),
      "no new rate-limit migration"
    );
  }

  section("helper: admin policy isolated from C7");
  {
    const db = mockRateDb();
    const ip = "203.0.113.80";
    for (let i = 0; i < ADMIN_ENV_PASSWORD_RATE_LIMIT; i++) {
      await recordPasswordLoginFailure(db, {
        ip,
        username: ADMIN_ENV_PASSWORD_RATE_USERNAME,
        policy: ADMIN_ENV_PASSWORD_RATE_POLICY,
      });
    }
    const admin = await readPasswordLoginRateLimit(db, {
      ip,
      username: ADMIN_ENV_PASSWORD_RATE_USERNAME,
      policy: ADMIN_ENV_PASSWORD_RATE_POLICY,
    });
    assert(admin.limited === true && admin.count === 20, "admin 20 claims limited");
    const c7 = await readPasswordLoginRateLimit(db, {
      ip,
      username: ADMIN_ENV_PASSWORD_RATE_USERNAME,
    });
    assert(c7.limited === false && c7.count === 0, "C7 bucket not shared with admin action");
    const otherIp = await readPasswordLoginRateLimit(db, {
      ip: "198.51.100.80",
      username: ADMIN_ENV_PASSWORD_RATE_USERNAME,
      policy: ADMIN_ENV_PASSWORD_RATE_POLICY,
    });
    assert(otherIp.limited === false, "other IP not locked");
    const down = mockRateDb({ failCreate: true });
    const claim = await claimPasswordLoginAttempt(down, {
      ip,
      username: ADMIN_ENV_PASSWORD_RATE_USERNAME,
      policy: ADMIN_ENV_PASSWORD_RATE_POLICY,
    });
    assert(claim.limited === false && claim.claimId === null, "admin store fail-open");
  }

  section("helper: NextAuth header IP");
  {
    assert(
      loginRateIpFromAuthHeaders({ "x-forwarded-for": "203.0.113.81, 10.0.0.1" }) ===
        "203.0.113.81",
      "record headers use leftmost XFF"
    );
    assert(
      loginRateIpFromAuthHeaders({
        get: (n: string) => (n.toLowerCase() === "x-forwarded-for" ? "198.51.100.9" : null),
      }) === "198.51.100.9",
      "Headers.get works"
    );
    assert(loginRateIpFromAuthHeaders(undefined) === "unknown", "missing headers → unknown");
  }

  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevAdminPw = process.env.ADMIN_PASSWORD;
  const prevAdminUser = process.env.ADMIN_USER;
  process.env.SESSION_SECRET = "admin-nextauth-rate-secret-32chars!!";
  process.env.ADMIN_PASSWORD = "unit-admin-env-pass-not-default";
  process.env.ADMIN_USER = "env_admin_rate_test";

  const { POST: adminPOST } = await import("../src/app/api/admin/route");
  const { POST: adminLoginPOST } = await import("../src/app/api/admin/login/route");
  const { POST: loginPOST } = await import("../src/app/api/login/route");

  const tag = `anr_${Date.now()}`;
  const hash = await bcrypt.hash("correct-login-pw", 4);
  const user = await prisma.user.create({
    data: {
      username: `${tag}_user`,
      password: hash,
      role: "admin",
      sessionVersion: 0,
    },
  });

  try {
    section("admin HTTP: generic fail + success cookie");
    {
      const ip = "203.0.113.90";
      const wrong = await adminPOST(
        jsonReq("https://example.com/api/admin", { password: "nope" }, ip)
      );
      const wrongBody = await wrong.json();
      assert(wrong.status === 401, "/api/admin wrong password 401");
      assert(wrongBody.error === "unauthorized", "admin generic error");
      assert(wrongBody.message === PASSWORD_LOGIN_FAIL_MESSAGE, "admin generic message");
      assert(!JSON.stringify(wrongBody).includes("INVALID_PASSWORD"), "no INVALID_PASSWORD");

      const empty = await adminLoginPOST(
        jsonReq("https://example.com/api/admin/login", {}, ip)
      );
      assert(empty.status === 401, "empty password 401");

      const badJson = await adminLoginPOST(
        new NextRequest("https://example.com/api/admin/login", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: "{",
        })
      );
      assert(badJson.status === 400, "malformed JSON stays 400");

      const ok = await adminLoginPOST(
        jsonReq(
          "https://example.com/api/admin/login",
          { password: process.env.ADMIN_PASSWORD },
          ip
        )
      );
      const okBody = await ok.json();
      assert(ok.status === 200 && okBody.ok === true, "admin login success");
      const cookies = (ok.headers.getSetCookie?.() ?? []).join("\n");
      assert(cookies.includes("vh_session="), "success sets vh_session");
    }

    section("admin HTTP: 20 then 429, other IP free, C7 untouched");
    {
      const ip = "203.0.113.91";
      for (let i = 0; i < ADMIN_ENV_PASSWORD_RATE_LIMIT; i++) {
        const res = await adminPOST(
          jsonReq("https://example.com/api/admin", { password: `guess-${i}` }, ip)
        );
        assert(res.status === 401, `admin fail ${i + 1} still 401`);
      }
      const blocked = await adminLoginPOST(
        jsonReq("https://example.com/api/admin/login", { password: "guess-final" }, ip)
      );
      const blockedBody = await blocked.json();
      assert(blocked.status === 429, "21st admin attempt 429");
      assert(blockedBody.error === "rate_limited", "admin 429 generic code");
      assert(blockedBody.message === PASSWORD_LOGIN_RATE_MESSAGE, "admin 429 message");
      assert(Number(blocked.headers.get("retry-after")) >= 1, "admin Retry-After");

      const otherIp = await adminPOST(
        jsonReq("https://example.com/api/admin", { password: "x" }, "198.51.100.91")
      );
      assert(otherIp.status === 401, "other IP not 429");

      const c7 = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: user.username, password: "wrong-pass" },
          ip
        )
      );
      assert(c7.status === 401, "C7 login on same IP still 401 not admin-429");
    }

    section("admin HTTP: concurrent burst");
    {
      const ip = "203.0.113.92";
      for (let i = 0; i < ADMIN_ENV_PASSWORD_RATE_LIMIT - 1; i++) {
        await recordPasswordLoginFailure(prisma, {
          ip,
          username: ADMIN_ENV_PASSWORD_RATE_USERNAME,
          policy: ADMIN_ENV_PASSWORD_RATE_POLICY,
        });
      }
      const burst = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          adminPOST(
            jsonReq("https://example.com/api/admin", { password: `burst-${i}` }, ip)
          )
        )
      );
      const extra401 = burst.filter((r) => r.status === 401).length;
      const limited429 = burst.filter((r) => r.status === 429).length;
      assert(extra401 <= 1, "admin burst allows at most the 20th fail");
      assert(limited429 >= 9, "rest of admin burst is 429");
      assert(extra401 + limited429 === 10, "admin burst only 401 or 429");
    }

    section("NextAuth credentials: generic fail / success / rate skip");
    {
      const ip = "203.0.113.93";
      const headers = { "x-forwarded-for": ip };
      const missing = await authorizePasswordCredentials(
        { username: `${tag}_missing`, password: "x" },
        { headers }
      );
      const wrong = await authorizePasswordCredentials(
        { username: user.username, password: "bad" },
        { headers }
      );
      assert(missing === null && wrong === null, "nextauth generic null on miss/wrong");

      const ok = await authorizePasswordCredentials(
        { username: user.username, password: "correct-login-pw" },
        { headers }
      );
      assert(ok?.id === String(user.id) && ok?.role === "admin", "nextauth db admin ok");

      const envOk = await authorizePasswordCredentials(
        {
          username: process.env.ADMIN_USER,
          password: process.env.ADMIN_PASSWORD,
        },
        { headers: { "x-forwarded-for": "203.0.113.94" } }
      );
      assert(envOk?.id === "env-admin" && envOk?.role === "admin", "nextauth env admin ok");

      const victim = `${tag}_na_limit`;
      for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMIT; i++) {
        const r = await authorizePasswordCredentials(
          { username: victim, password: `g-${i}` },
          { headers }
        );
        assert(r === null, `nextauth fail ${i + 1} null`);
      }
      const limited = await authorizePasswordCredentials(
        { username: victim, password: "g-final" },
        { headers }
      );
      assert(limited === null, "9th nextauth still generic null (no 429 channel)");
      const after = await readPasswordLoginRateLimit(prisma, { ip, username: victim });
      assert(after.limited === true && after.count >= 9, "nextauth 9th claimed without bcrypt path");

      const otherUser = await authorizePasswordCredentials(
        { username: user.username, password: "bad" },
        { headers }
      );
      assert(otherUser === null, "same IP other username still tries (not blocked by victim)");
      const otherIp = await authorizePasswordCredentials(
        { username: victim, password: "x" },
        { headers: { "x-forwarded-for": "198.51.100.93" } }
      );
      assert(otherIp === null, "other IP not limited for victim");
    }

    section("NextAuth concurrent burst");
    {
      const ip = "203.0.113.95";
      const victim = `${tag}_na_race`;
      for (let i = 0; i < 7; i++) {
        await recordPasswordLoginFailure(prisma, { ip, username: victim });
      }
      const burst = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          authorizePasswordCredentials(
            { username: victim, password: `burst-${i}` },
            { headers: { "x-forwarded-for": ip } }
          )
        )
      );
      assert(burst.every((r) => r === null), "burst all generic null");
      const after = await readPasswordLoginRateLimit(prisma, { ip, username: victim });
      assert(after.count >= 8 && after.limited === true, "burst claimed past threshold");
    }
  } finally {
    await prisma.audit.deleteMany({
      where: {
        action: { in: [PASSWORD_LOGIN_RATE_ACTION, ADMIN_ENV_PASSWORD_RATE_ACTION] },
        entity: PASSWORD_LOGIN_RATE_ENTITY,
      },
    });
    await prisma.user.deleteMany({ where: { username: { startsWith: tag } } });
    if (prevSecret == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevAdminPw == null) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prevAdminPw;
    if (prevAdminUser == null) delete process.env.ADMIN_USER;
    else process.env.ADMIN_USER = prevAdminUser;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
