/**
 * C6 account enumeration + C7 password-login rate limit.
 * local caddy_local only. No production write. No live push.
 * 실행: npm run test:password-login-security-unit
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
  PASSWORD_LOGIN_RATE_ACTION,
  PASSWORD_LOGIN_RATE_ENTITY,
  PASSWORD_LOGIN_RATE_LIMIT,
  PASSWORD_LOGIN_RATE_WINDOW_MS,
  clearPasswordLoginFailures,
  readPasswordLoginRateLimit,
  recordPasswordLoginFailure,
  type PasswordLoginRateDb,
} from "../src/lib/passwordLoginRateLimit";
import { passwordLogin } from "../src/lib/passwordLogin";

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

function jsonReq(
  url: string,
  body: unknown,
  ip?: string
) {
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

function mockRateDb(): PasswordLoginRateDb & { rows: Array<{ ip: string; u: string; createdAt: Date }> } {
  const rows: Array<{ ip: string; u: string; createdAt: Date }> = [];
  return {
    rows,
    audit: {
      async count({ where }) {
        const since = where.createdAt.gte;
        return rows.filter(
          (r) =>
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
              r.ip === where.ip &&
              r.u === where.payload.equals.u &&
              r.createdAt >= since
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        return hit ? { createdAt: hit.createdAt } : null;
      },
      async create({ data }) {
        rows.push({
          ip: data.ip,
          u: data.payload.u,
          createdAt: new Date(),
        });
        return { id: rows.length };
      },
      async deleteMany({ where }) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].ip === where.ip && rows[i].u === where.payload.equals.u) {
            rows.splice(i, 1);
          }
        }
        return { count: before - rows.length };
      },
    },
  };
}

async function main() {
  section("source: C6 unify + C7 audit store");
  {
    const authLogin = read("src/app/api/auth/login/route.ts");
    const login = read("src/app/api/login/route.ts");
    const helper = read("src/lib/passwordLoginRateLimit.ts");
    const pw = read("src/lib/passwordLogin.ts");
    const client = read("src/app/login/LoginClient.tsx");
    assert(authLogin.includes("passwordLoginUnauthorizedResponse"), "auth/login unified fail");
    assert(login.includes("passwordLoginUnauthorizedResponse"), "/api/login unified fail");
    assert(!authLogin.includes("비밀번호가 올바르지 않습니다."), "auth/login no bad_password copy");
    assert(!authLogin.includes("존재하지 않거나 권한이 없습니다."), "auth/login no not_found copy");
    assert(authLogin.includes("readPasswordLoginRateLimit"), "auth/login rate limit");
    assert(login.includes("readPasswordLoginRateLimit"), "/api/login rate limit");
    assert(helper.includes("Audit.count"), "documents Audit.count");
    assert(!helper.includes("setTimeout"), "no setTimeout store");
    assert(!/new Map\(/.test(helper), "no process Map store");
    assert(helper.includes("payload: { u: username }"), "payload is username only");
    assert(!helper.includes("password:"), "rate helper writes no password field");
    assert(!/payload:\s*\{[^}]*hash/.test(helper), "rate helper payload has no hash");
    assert(!helper.includes("vh_session"), "rate helper writes no session");
    assert(pw.includes("TIMING_PAD_HASH"), "missing user still compares");
    assert(client.includes("data?.message || data?.error"), "login UI prefers generic message");
    assert(!client.includes("존재하지 않는"), "login UI no existence copy");
    const schema = read("prisma/schema.prisma");
    assert(schema.includes("model Audit"), "reuses Audit — no new model");
    const migs = fs.readdirSync(path.resolve("prisma/migrations"));
    assert(
      !migs.some((n) => /login.?rate|password.?login.?fail/i.test(n)),
      "no login rate-limit migration"
    );
    const kakaoCb = read("src/app/api/auth/kakao/callback/route.ts");
    const kakaoNative = read("src/app/api/auth/kakao/native-session/route.ts");
    assert(kakaoCb.includes("findOrCreateKakaoSessionUser"), "kakao callback untouched");
    assert(kakaoNative.includes("exchangeNativeKakaoSession"), "kakao native untouched");
  }

  section("helper: IP+account key, no IP-wide lock");
  {
    const db = mockRateDb();
    const ip = "203.0.113.10";
    for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMIT - 1; i++) {
      await recordPasswordLoginFailure(db, { ip, username: "alice" });
    }
    const under = await readPasswordLoginRateLimit(db, { ip, username: "alice" });
    assert(under.limited === false && under.count === 7, "7 fails still allowed");
    await recordPasswordLoginFailure(db, { ip, username: "alice" });
    const over = await readPasswordLoginRateLimit(db, { ip, username: "alice" });
    assert(over.limited === true, "8th fail locks alice@IP");
    assert(over.retryAfterSec >= 1, "Retry-After seconds");
    const otherUser = await readPasswordLoginRateLimit(db, { ip, username: "bob" });
    assert(otherUser.limited === false, "same IP other account not locked");
    const otherIp = await readPasswordLoginRateLimit(db, {
      ip: "198.51.100.7",
      username: "alice",
    });
    assert(otherIp.limited === false, "same account other IP not locked");
    await clearPasswordLoginFailures(db, { ip, username: "alice" });
    const cleared = await readPasswordLoginRateLimit(db, { ip, username: "alice" });
    assert(cleared.limited === false && cleared.count === 0, "success clears that key");
    assert(PASSWORD_LOGIN_RATE_WINDOW_MS === 15 * 60 * 1000, "15 minute window");
    assert(PASSWORD_LOGIN_RATE_LIMIT === 8, "threshold 8");
  }

  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "password-login-security-secret-32!!";
  const { POST: loginPOST } = await import("../src/app/api/login/route");
  const { POST: authLoginPOST } = await import("../src/app/api/auth/login/route");

  const tag = `pls_${Date.now()}`;
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
    section("C6 HTTP: unknown vs wrong password indistinguishable");
    {
      const ip = "203.0.113.20";
      const missing = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: `${tag}_missing`, password: "any-pass" },
          ip
        )
      );
      const wrong = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: user.username, password: "wrong-pass" },
          ip
        )
      );
      const missingBody = await missing.json();
      const wrongBody = await wrong.json();
      assert(missing.status === 401 && wrong.status === 401, "both 401");
      assert(missingBody.error === wrongBody.error, "same error code");
      assert(missingBody.message === wrongBody.message, "same message");
      assert(missingBody.message === PASSWORD_LOGIN_FAIL_MESSAGE, "generic fail copy");
      assert(JSON.stringify(missingBody) === JSON.stringify(wrongBody), "identical JSON");

      const authMissing = await authLoginPOST(
        jsonReq(
          "https://example.com/api/auth/login",
          { username: `${tag}_missing2`, password: "any-pass" },
          ip
        )
      );
      const authWrong = await authLoginPOST(
        jsonReq(
          "https://example.com/api/auth/login",
          { username: user.username, password: "wrong-pass-2" },
          ip
        )
      );
      const aM = await authMissing.json();
      const aW = await authWrong.json();
      assert(authMissing.status === 401 && authWrong.status === 401, "auth/login both 401");
      assert(JSON.stringify(aM) === JSON.stringify(aW), "auth/login identical JSON");
      assert(aM.message === PASSWORD_LOGIN_FAIL_MESSAGE, "auth/login generic copy");
    }

    section("C6 success + session still works");
    {
      const ok = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: user.username, password: "correct-login-pw" },
          "203.0.113.21"
        )
      );
      const body = await ok.json();
      assert(ok.status === 200 && body.ok === true, "correct password 200");
      assert(body.role === "admin", "admin role unchanged");
      assert(body.mustChangePassword === false, "mustChangePassword false");
      const cookies = (ok.headers.getSetCookie?.() ?? []).join("\n");
      assert(cookies.includes("vh_session="), "session cookie set");
    }

    section("C7 HTTP: threshold / other account / other IP / 429 generic");
    {
      const ipA = "203.0.113.30";
      const victim = `${tag}_limit_me`;
      let last = { status: 0, body: {} as Record<string, unknown>, retry: "" };
      for (let i = 0; i < PASSWORD_LOGIN_RATE_LIMIT; i++) {
        const res = await loginPOST(
          jsonReq(
            "https://example.com/api/login",
            { username: victim, password: `guess-${i}` },
            ipA
          )
        );
        last = {
          status: res.status,
          body: (await res.json()) as Record<string, unknown>,
          retry: res.headers.get("retry-after") ?? "",
        };
        assert(res.status === 401, `fail ${i + 1} still 401`);
      }
      const blocked = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: victim, password: "guess-final" },
          ipA
        )
      );
      const blockedBody = await blocked.json();
      assert(blocked.status === 429, "9th attempt 429");
      assert(blockedBody.error === "rate_limited", "429 generic code");
      assert(blockedBody.message === PASSWORD_LOGIN_RATE_MESSAGE, "429 generic message");
      assert(Number(blocked.headers.get("retry-after")) >= 1, "Retry-After present");
      assert(!JSON.stringify(blockedBody).includes("존재하지"), "429 no existence copy");
      assert(last.status === 401, "8th was still unauthorized");

      const otherAccount = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: `${tag}_other`, password: "x" },
          ipA
        )
      );
      assert(otherAccount.status === 401, "same IP other username not 429");

      const otherIp = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: victim, password: "x" },
          "198.51.100.30"
        )
      );
      assert(otherIp.status === 401, "same username other IP not 429");

      const success = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: user.username, password: "correct-login-pw" },
          ipA
        )
      );
      assert(success.status === 200, "unrelated success still works on same IP");
    }

    section("C7 success clears that IP+account window");
    {
      const ip = "203.0.113.40";
      for (let i = 0; i < 3; i++) {
        const res = await loginPOST(
          jsonReq(
            "https://example.com/api/login",
            { username: user.username, password: "nope" },
            ip
          )
        );
        assert(res.status === 401, `pre-success fail ${i + 1}`);
      }
      const ok = await loginPOST(
        jsonReq(
          "https://example.com/api/login",
          { username: user.username, password: "correct-login-pw" },
          ip
        )
      );
      assert(ok.status === 200, "success after few fails");
      const after = await readPasswordLoginRateLimit(prisma, {
        ip,
        username: user.username,
      });
      assert(after.count === 0 && after.limited === false, "success cleared fail rows");
    }

    section("passwordLogin reasons stay internal");
    {
      const missing = await passwordLogin(`${tag}_nope`, "x", prisma);
      const wrong = await passwordLogin(user.username, "bad", prisma);
      assert(missing.status === "unauthorized", "internal missing unauthorized");
      assert(wrong.status === "unauthorized", "internal wrong unauthorized");
      assert(
        missing.status === "unauthorized" && missing.reason === "not_found",
        "internal still not_found"
      );
      assert(
        wrong.status === "unauthorized" && wrong.reason === "bad_password",
        "internal still bad_password"
      );
    }
  } finally {
    await prisma.audit.deleteMany({
      where: {
        action: PASSWORD_LOGIN_RATE_ACTION,
        entity: PASSWORD_LOGIN_RATE_ENTITY,
      },
    });
    await prisma.user.deleteMany({ where: { username: { startsWith: tag } } });
    if (prevSecret == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
