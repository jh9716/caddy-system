/**
 * Session Persistence V1
 * local caddy_local writes only. No Preview/production mutation.
 *
 * 실행: npm run test:session-persistence-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  ADMIN_SESSION_MAX_AGE_SEC,
  CADDY_SESSION_MAX_AGE_SEC,
  ENV_SESSION_MAX_AGE_SEC,
  LEADER_SESSION_MAX_AGE_SEC,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SEC,
  applySessionCookies,
  buildSessionClaims,
  sessionMaxAgeSec,
  signSessionClaims,
  verifySignedSessionToken,
} from "../src/lib/sessionCookies";
import {
  isRetiredCaddySessionBlocked,
  resolveAuthFromCookieStore,
} from "../src/lib/auth";
import {
  employmentBecameRetired,
  incrementSessionVersionForCaddyLink,
  writeCaddyRevokingRetiredSessions,
} from "../src/lib/sessionRevocation";
import { unlinkUserFromCaddy } from "../src/lib/userCaddyLink";
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

function section(title: string) {
  console.log("\n==", title, "==");
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

function fakeReq(url: string) {
  return {
    url,
    headers: { get() { return null; } },
    nextUrl: { protocol: new URL(url).protocol },
  } as any;
}

function parseSetCookie(line: string) {
  const parts = line.split(";").map((p) => p.trim());
  const [nv, ...attrs] = parts;
  const eq = nv.indexOf("=");
  const name = nv.slice(0, eq);
  const value = nv.slice(eq + 1);
  const map: Record<string, string> = {};
  for (const a of attrs) {
    const i = a.indexOf("=");
    if (i < 0) map[a.toLowerCase()] = "true";
    else map[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
  }
  return { name, value, attrs: map };
}

function vhSessionLine(setCookies: string[]) {
  return setCookies.find((l) => l.startsWith(`${SESSION_COOKIE_NAME}=`));
}

async function main() {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "session-persist-unit-secret-32chars!";

  section("A. TTL constants");
  assert(ENV_SESSION_MAX_AGE_SEC === 60 * 60 * 8, "env 8h");
  assert(ADMIN_SESSION_MAX_AGE_SEC === 60 * 60 * 24, "admin 24h");
  assert(CADDY_SESSION_MAX_AGE_SEC === 60 * 60 * 24 * 30, "caddy 30d");
  assert(LEADER_SESSION_MAX_AGE_SEC === CADDY_SESSION_MAX_AGE_SEC, "leader=caddy 30d");
  assert(SESSION_MAX_AGE_SEC === ENV_SESSION_MAX_AGE_SEC, "legacy alias is env 8h");
  assert(
    sessionMaxAgeSec({ userId: 1, role: "caddy" }) === CADDY_SESSION_MAX_AGE_SEC,
    "DB caddy 30d"
  );
  assert(
    sessionMaxAgeSec({ userId: 2, role: "leader" }) === LEADER_SESSION_MAX_AGE_SEC,
    "DB leader 30d"
  );
  assert(
    sessionMaxAgeSec({ userId: 3, role: "admin" }) === ADMIN_SESSION_MAX_AGE_SEC,
    "DB admin 24h"
  );
  assert(
    sessionMaxAgeSec({ userId: null, role: "admin" }) === ENV_SESSION_MAX_AGE_SEC,
    "env admin 8h"
  );
  assert(
    sessionMaxAgeSec({ userId: null, role: "caddy" }) === ENV_SESSION_MAX_AGE_SEC,
    "env caddy 8h"
  );

  section("A. cookie maxAge === token exp-iat");
  {
    const now = 1_800_000_000;
    const cases: Array<{
      userId: number | null;
      role: "admin" | "caddy" | "leader";
      expect: number;
    }> = [
      { userId: 11, role: "caddy", expect: CADDY_SESSION_MAX_AGE_SEC },
      { userId: 12, role: "leader", expect: LEADER_SESSION_MAX_AGE_SEC },
      { userId: 13, role: "admin", expect: ADMIN_SESSION_MAX_AGE_SEC },
      { userId: null, role: "admin", expect: ENV_SESSION_MAX_AGE_SEC },
      { userId: null, role: "caddy", expect: ENV_SESSION_MAX_AGE_SEC },
    ];
    for (const c of cases) {
      const claims = buildSessionClaims({
        userId: c.userId,
        username: `u_${c.role}_${c.userId ?? "env"}`,
        role: c.role,
        sessionVersion: 1,
        nowSec: now,
      });
      assert(claims.exp - claims.iat === c.expect, `claims ${c.role} uid=${c.userId} delta`);
      const res = NextResponse.json({ ok: true });
      await applySessionCookies(res, fakeReq("https://www.verthill.kr/api/login"), {
        userId: c.userId,
        username: claims.username,
        role: c.role,
        sessionVersion: 1,
      });
      const line = vhSessionLine(res.headers.getSetCookie?.() ?? []);
      assert(!!line, `Set-Cookie ${c.role} uid=${c.userId}`);
      if (!line) continue;
      const parsed = parseSetCookie(line);
      assert(Number(parsed.attrs["max-age"]) === c.expect, `Max-Age ${c.role} uid=${c.userId}`);
      const token = decodeURIComponent(parsed.value.replace(/^"/, "").replace(/"$/, ""));
      const verified = await verifySignedSessionToken(token);
      assert(!!verified, `token verifies ${c.role} uid=${c.userId}`);
      assert(
        verified != null && verified.exp - verified.iat === c.expect,
        `token delta matches cookie ${c.role} uid=${c.userId}`
      );
      assert(
        Number(parsed.attrs["max-age"]) === (verified ? verified.exp - verified.iat : -1),
        `cookie Max-Age === token exp-iat ${c.role} uid=${c.userId}`
      );
      assert(parsed.attrs.httponly === "true", `HttpOnly ${c.role}`);
      assert(String(parsed.attrs.samesite).toLowerCase() === "lax", `SameSite=Lax ${c.role}`);
      assert(parsed.attrs.secure === "true", `Secure on https ${c.role}`);
      assert(parsed.attrs.path === "/", `Path=/ ${c.role}`);
      assert(!("domain" in parsed.attrs), `no Domain attr ${c.role}`);
    }
  }

  section("B. Kakao / credentials same applySessionCookies");
  {
    const kakao = read("src/app/api/auth/kakao/callback/route.ts");
    const login = read("src/app/api/login/route.ts");
    const authLogin = read("src/app/api/auth/login/route.ts");
    const oauth = read("src/lib/kakaoOAuth.ts");
    assert(kakao.includes("applySessionCookies"), "Kakao callback issues vh_session");
    assert(login.includes("applySessionCookies"), "credentials /api/login issues vh_session");
    assert(authLogin.includes("applySessionCookies"), "credentials /api/auth/login issues vh_session");
    assert(!kakao.includes("refresh_token"), "Kakao callback does not persist refresh_token");
    assert(!/prisma\.\w+\.create\(/.test(kakao) || kakao.includes("kakaoUserId"), "Kakao upsert User only");
    assert(!oauth.includes("prisma."), "kakaoOAuth stores no token in DB");
    const applyCall = kakao.slice(kakao.lastIndexOf("await applySessionCookies"));
    assert(
      !/access_token|refresh_token/.test(applyCall),
      "applySessionCookies call does not pass Kakao tokens"
    );
  }

  section("C. sessionVersion reuse / no new schema");
  {
    const schema = read("prisma/schema.prisma");
    assert(schema.includes("sessionVersion Int @default(0)"), "User.sessionVersion kept");
    assert(!schema.includes("tokenVersion"), "no tokenVersion");
    assert(!schema.includes("authVersion"), "no authVersion");
    assert(!schema.includes("passwordChangedAt"), "no passwordChangedAt");
    assert(!/revokedAt/.test(schema.split("model User")[1]?.split("model ")[0] || ""), "User has no revokedAt");
    const migrations = fs.readdirSync(path.join(process.cwd(), "prisma/migrations"));
    assert(
      !migrations.some((n) => /session.?persist|token.?version/i.test(n)),
      "no new session persistence migration"
    );
    const auth = read("src/lib/auth.ts");
    assert(auth.includes("user.sessionVersion !== session.sv"), "sv mismatch rejects");
    assert(auth.includes("role: dbRole"), "DB role is authorization role");
    const logout = read("src/app/api/logout/route.ts");
    const logoutAll = read("src/app/api/auth/logout-all/route.ts");
    assert(logout.includes("clearSessionCookies") && !logout.includes("sessionVersion"), "logout cookie-only");
    assert(
      logoutAll.includes("sessionVersion: { increment: 1 }"),
      "logout-all increments sessionVersion"
    );
    assert(logoutAll.includes("userId == null"), "env logout-all still unavailable");
  }

  section("D. RETIRED block helper (caddy/leader only)");
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
      caddyId: 1,
      employmentStatus: "LEAVE",
    }) === false,
    "LEAVE caddy allowed"
  );
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
      role: "leader",
      caddyId: 2,
      employmentStatus: "RETIRED",
    }) === true,
    "RETIRED leader blocked"
  );
  assert(
    isRetiredCaddySessionBlocked({
      role: "admin",
      caddyId: 3,
      employmentStatus: "RETIRED",
    }) === false,
    "admin + RETIRED caddyId still allowed"
  );
  assert(
    isRetiredCaddySessionBlocked({
      role: "caddy",
      caddyId: null,
      employmentStatus: "RETIRED",
    }) === false,
    "unlinked caddy not blocked by RETIRED"
  );
  assert(employmentBecameRetired("ACTIVE", "RETIRED") === true, "ACTIVE→RETIRED");
  assert(employmentBecameRetired("RETIRED", "RETIRED") === false, "already RETIRED");
  assert(employmentBecameRetired("ACTIVE", "LEAVE") === false, "ACTIVE→LEAVE no revoke");

  section("E. unlink source");
  {
    const unlinkSrc = read("src/lib/userCaddyLink.ts");
    assert(
      unlinkSrc.includes("caddyId: null") &&
        unlinkSrc.includes("sessionVersion: { increment: 1 }"),
      "unlink updateMany sets caddyId null + sv increment"
    );
  }

  section("F. /caddy RSC layout + check-role");
  {
    const layout = read("src/app/caddy/layout.tsx");
    const checkRole = read("src/app/api/check-role/route.ts");
    const mw = read("src/middleware.ts");
    assert(layout.includes("getRequestAuthUser"), "/caddy layout uses getRequestAuthUser");
    assert(layout.includes('callbackUrl=/caddy'), "/caddy layout redirects to login");
    assert(layout.includes('auth.role !== "admin"'), "/caddy layout still allows admin");
    assert(!layout.includes("prisma."), "/caddy layout does not query prisma directly");
    assert(checkRole.includes("resolveAuthFromCookieStore"), "check-role uses resolveAuthUser path");
    assert(checkRole.includes("{ role: auth.role }") || checkRole.includes("role: auth.role"), "check-role keeps role field");
    assert(checkRole.includes("role: null") || checkRole.includes("role:null"), "unauth role null");
    assert(!mw.includes("prisma"), "middleware still has no Prisma");
    assert(!mw.includes("@/lib/prisma"), "middleware does not import prisma");
  }

  section("G. PWA cookie / SW regression (source)");
  {
    const sw = read("public/sw.js");
    const sessionSrc = read("src/lib/sessionCookies.ts");
    const manifest = read("src/app/manifest.ts");
    assert(!/caches\.(open|match|put|keys)/.test(sw), "SW still does not use Cache Storage");
    assert(sw.includes("Network-only") || sw.includes("no-op"), "SW fetch remains network-only");
    assert(!sessionSrc.includes("domain:"), "sessionCookies never sets Domain");
    assert(manifest.includes("PWA_START_URL"), "manifest still uses shared PWA constants");
    assert(!fs.existsSync(path.resolve("prisma/migrations/20260917000000_session_persist")), "no persist migration folder");
  }

  section("H. no admin revoke endpoint this PR");
  {
    assert(
      !fs.existsSync(path.resolve("src/app/api/admin/users/[id]/revoke-sessions/route.ts")),
      "no new admin revoke-sessions route"
    );
    const files: string[] = [];
    function walk(dir: string) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(ent.name)) files.push(p);
      }
    }
    walk(path.resolve("src/app/api"));
    const hits = files.filter((f) => {
      const t = fs.readFileSync(f, "utf8");
      return /revoke-sessions|forceLogout|force-logout/.test(t);
    });
    assert(hits.length === 0, "no new force-logout API files");
  }

  section("I. increment helper (in-memory)");
  {
    const rows = new Map<number, { caddyId: number | null; sessionVersion: number }>([
      [1, { caddyId: 50, sessionVersion: 4 }],
      [2, { caddyId: 51, sessionVersion: 0 }],
    ]);
    const db = {
      user: {
        async updateMany(args: {
          where: { caddyId: number };
          data: { sessionVersion: { increment: number } };
        }) {
          let count = 0;
          for (const row of rows.values()) {
            if (row.caddyId === args.where.caddyId) {
              row.sessionVersion += args.data.sessionVersion.increment;
              count += 1;
            }
          }
          return { count };
        },
      },
    };
    const n = await incrementSessionVersionForCaddyLink(db as any, 50);
    assert(n === 1, "one linked user bumped");
    assert(rows.get(1)?.sessionVersion === 5, "sv 4→5");
    assert(rows.get(2)?.sessionVersion === 0, "other caddy untouched");
    const none = await incrementSessionVersionForCaddyLink(db as any, 999);
    assert(none === 0, "unlinked caddy no-op");
  }

  section("J. writeCaddyRevokingRetiredSessions (in-memory tx)");
  {
    let retired = false;
    let sv = 1;
    const db: any = {
      async $transaction(fn: (tx: any) => Promise<unknown>) {
        return fn(db);
      },
      caddy: {
        async update() {
          retired = true;
          return { employmentStatus: "RETIRED" };
        },
      },
      user: {
        async updateMany() {
          sv += 1;
          return { count: 1 };
        },
      },
    };
    await writeCaddyRevokingRetiredSessions(db, {
      caddyId: 7,
      previousEmployment: "ACTIVE",
      nextEmployment: "RETIRED",
      write: (tx) => tx.caddy.update({ where: { id: 7 }, data: {} } as any),
    });
    assert(retired && sv === 2, "RETIRED write + sv bump in tx");

    let leaveWrite = false;
    let sv2 = 1;
    const dbLeave: any = {
      async $transaction() {
        throw new Error("LEAVE must not open revoke tx");
      },
      caddy: {
        async update() {
          leaveWrite = true;
          return { employmentStatus: "LEAVE" };
        },
      },
      user: {
        async updateMany() {
          sv2 += 1;
          return { count: 1 };
        },
      },
    };
    await writeCaddyRevokingRetiredSessions(dbLeave, {
      caddyId: 8,
      previousEmployment: "ACTIVE",
      nextEmployment: "LEAVE",
      write: (tx) => tx.caddy.update({ where: { id: 8 }, data: {} } as any),
    });
    assert(leaveWrite && sv2 === 1, "LEAVE write does not bump sv");
  }

  section("K. local DB: RETIRED / LEAVE / unlink / role / logout-all");
  try {
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL =
        "postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public";
    }
    assertLocalDatabaseUrl(process.env.DATABASE_URL);
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const tag = `__spv1_${Date.now()}`;
    try {
      const caddyActive = await prisma.caddy.create({
        data: {
          name: `${tag}_active`,
          team: "1조",
          teamOrder: 97,
          employmentStatus: "ACTIVE",
        },
      });
      const caddyLeave = await prisma.caddy.create({
        data: {
          name: `${tag}_leave`,
          team: "1조",
          teamOrder: 98,
          employmentStatus: "LEAVE",
        },
      });
      const caddyRet = await prisma.caddy.create({
        data: {
          name: `${tag}_ret`,
          team: "1조",
          teamOrder: 99,
          employmentStatus: "ACTIVE",
        },
      });

      const uCaddy = await prisma.user.create({
        data: {
          username: `${tag}_caddy`,
          password: await bcrypt.hash("persist-caddy-pw", 4),
          role: "caddy",
          sessionVersion: 2,
          caddyId: caddyActive.id,
          kakaoUserId: `9${Date.now()}`,
          managedTeams: [],
        },
      });
      const uLeave = await prisma.user.create({
        data: {
          username: `${tag}_leave`,
          password: null,
          role: "caddy",
          sessionVersion: 0,
          caddyId: caddyLeave.id,
          kakaoUserId: `8${Date.now()}`,
          managedTeams: [],
        },
      });
      const uRet = await prisma.user.create({
        data: {
          username: `${tag}_ret`,
          password: null,
          role: "caddy",
          sessionVersion: 0,
          caddyId: caddyRet.id,
          kakaoUserId: `7${Date.now()}`,
          managedTeams: [],
        },
      });
      const uAdmin = await prisma.user.create({
        data: {
          username: `${tag}_admin`,
          password: await bcrypt.hash("persist-admin-pw", 4),
          role: "caddy",
          sessionVersion: 0,
          managedTeams: [],
        },
      });
      const uLeader = await prisma.user.create({
        data: {
          username: `${tag}_leader`,
          password: null,
          role: "leader",
          sessionVersion: 0,
          managedTeams: [],
        },
      });

      const tokCaddy = await signSessionClaims(
        buildSessionClaims({
          userId: uCaddy.id,
          username: uCaddy.username,
          role: "caddy",
          sessionVersion: 2,
        })
      );
      const aCaddy = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokCaddy })
      );
      assert(aCaddy?.role === "caddy" && aCaddy.caddyId === caddyActive.id, "ACTIVE caddy auth ok");

      const tokLeave = await signSessionClaims(
        buildSessionClaims({
          userId: uLeave.id,
          username: uLeave.username,
          role: "caddy",
          sessionVersion: 0,
        })
      );
      const aLeave = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokLeave })
      );
      assert(aLeave?.role === "caddy", "LEAVE caddy auth ok");

      await writeCaddyRevokingRetiredSessions(prisma, {
        caddyId: caddyRet.id,
        previousEmployment: "ACTIVE",
        nextEmployment: "RETIRED",
        write: (tx) =>
          tx.caddy.update({
            where: { id: caddyRet.id },
            data: { employmentStatus: "RETIRED" },
          }),
      });
      const retUser = await prisma.user.findUnique({
        where: { id: uRet.id },
        select: { sessionVersion: true },
      });
      assert(retUser?.sessionVersion === 1, "RETIRED write bumped linked sv");
      const tokRetOld = await signSessionClaims(
        buildSessionClaims({
          userId: uRet.id,
          username: uRet.username,
          role: "caddy",
          sessionVersion: 0,
        })
      );
      const aRetOld = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokRetOld })
      );
      assert(aRetOld === null, "pre-RETIRED cookie rejected (sv + RETIRED)");
      const tokRetNew = await signSessionClaims(
        buildSessionClaims({
          userId: uRet.id,
          username: uRet.username,
          role: "caddy",
          sessionVersion: 1,
        })
      );
      const aRetNew = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokRetNew })
      );
      assert(aRetNew === null, "even matching sv, RETIRED caddy/leader blocked");

      const tokMismatchRole = await signSessionClaims(
        buildSessionClaims({
          userId: uAdmin.id,
          username: uAdmin.username,
          role: "caddy",
          sessionVersion: 0,
        })
      );
      await prisma.user.update({
        where: { id: uAdmin.id },
        data: { role: "admin" },
      });
      const aDbRole = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokMismatchRole })
      );
      assert(aDbRole?.role === "admin", "cookie caddy + DB admin → DB role wins");

      const tokLeaderCookieAdmin = await signSessionClaims(
        buildSessionClaims({
          userId: uLeader.id,
          username: uLeader.username,
          role: "admin",
          sessionVersion: 0,
        })
      );
      const aLeader = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokLeaderCookieAdmin })
      );
      assert(aLeader?.role === "leader", "cookie admin + DB leader → leader");

      const svBeforeUnlink = uCaddy.sessionVersion;
      const unlink = await unlinkUserFromCaddy(prisma, uCaddy.id);
      assert(unlink.previousCaddyId === caddyActive.id, "unlink previous caddyId");
      const afterUnlink = await prisma.user.findUnique({
        where: { id: uCaddy.id },
        select: { caddyId: true, sessionVersion: true },
      });
      assert(afterUnlink?.caddyId == null, "unlink cleared caddyId");
      assert(
        afterUnlink?.sessionVersion === svBeforeUnlink + 1,
        "unlink incremented sessionVersion"
      );
      const aUnlinkOld = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokCaddy })
      );
      assert(aUnlinkOld === null, "pre-unlink session rejected");
      const tokAfterUnlink = await signSessionClaims(
        buildSessionClaims({
          userId: uCaddy.id,
          username: uCaddy.username,
          role: "caddy",
          sessionVersion: afterUnlink!.sessionVersion,
        })
      );
      const aFresh = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokAfterUnlink })
      );
      assert(
        aFresh?.role === "caddy" && aFresh.caddyId == null,
        "new login after unlink allowed (caddy/link path)"
      );

      await prisma.user.update({
        where: { id: uLeave.id },
        data: { sessionVersion: { increment: 1 } },
      });
      const aLeaveStale = await resolveAuthFromCookieStore(
        cookieJar({ [SESSION_COOKIE_NAME]: tokLeave })
      );
      assert(aLeaveStale === null, "logout-all style sv bump rejects old cookie");

      const { POST: loginPOST } = await import("../src/app/api/login/route");
      const snapAdmin = process.env.ADMIN_PASSWORD;
      const snapCaddy = process.env.CADDY_PASSWORD;
      delete process.env.ADMIN_PASSWORD;
      delete process.env.CADDY_PASSWORD;
      try {
        const cred = await loginPOST(
          new (await import("next/server")).NextRequest("https://www.verthill.kr/api/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              username: uCaddy.username,
              password: "persist-caddy-pw",
            }),
          })
        );
        assert(cred.status === 200, "credentials caddy login 200");
        const credLine = vhSessionLine(cred.headers.getSetCookie?.() ?? []);
        assert(!!credLine, "credentials sets vh_session");
        if (credLine) {
          const parsed = parseSetCookie(credLine);
          assert(
            Number(parsed.attrs["max-age"]) === CADDY_SESSION_MAX_AGE_SEC,
            "credentials DB caddy cookie 30d"
          );
        }

        const adminLogin = await loginPOST(
          new (await import("next/server")).NextRequest("https://www.verthill.kr/api/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              username: uAdmin.username,
              password: "persist-admin-pw",
            }),
          })
        );
        assert(adminLogin.status === 200, "credentials admin login 200");
        const adminLine = vhSessionLine(adminLogin.headers.getSetCookie?.() ?? []);
        if (adminLine) {
          const parsed = parseSetCookie(adminLine);
          assert(
            Number(parsed.attrs["max-age"]) === ADMIN_SESSION_MAX_AGE_SEC,
            "credentials DB admin cookie 24h"
          );
        }
      } finally {
        if (snapAdmin === undefined) delete process.env.ADMIN_PASSWORD;
        else process.env.ADMIN_PASSWORD = snapAdmin;
        if (snapCaddy === undefined) delete process.env.CADDY_PASSWORD;
        else process.env.CADDY_PASSWORD = snapCaddy;
      }
    } finally {
      await prisma.user.deleteMany({ where: { username: { startsWith: tag } } });
      await prisma.caddy.deleteMany({ where: { name: { startsWith: tag } } });
      await prisma.$disconnect();
    }
  } catch (e: any) {
    assert(false, `local DB persistence tests failed: ${e?.message || e}`);
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
