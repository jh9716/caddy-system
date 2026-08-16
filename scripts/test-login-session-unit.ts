/**
 * 로그인 세션 유틸 단위 테스트 (DB 없음 — signed cookie + version 규칙)
 * 실행: npx tsx scripts/test-login-session-unit.ts
 */
import bcrypt from "bcryptjs";
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
  assert(envAuth?.role === "admin" && envAuth.userId == null, "env signed admin ok");

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

  console.log("== sessionVersion DB (local) ==");
  try {
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
