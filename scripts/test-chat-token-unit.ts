/**
 * Chat Phase 2 token / eligibility / identity.
 * 실행: npm run test:chat-token-unit
 */
import { createHmac } from "node:crypto";
import { ChatAuthError, issueChatAccessToken, resolveChatEligibility } from "../src/lib/chatAuth";
import type { ResolvedAuthUser } from "../src/lib/auth";
import { resolveChatRoomAccess } from "../src/lib/chatAcl";
import {
  parseAdminChatUserId,
  resolveEnvAdminChatIdentity,
} from "../src/lib/chatEnvAdminIdentity";
import { collectChatInviteMembers, listInvitableChatUsers, type ChatUserRow } from "../src/lib/chatUsers";
import { chatRoomIdToTeam, isChatRoomId, isCustomRoomId, teamToChatRoomId } from "../src/lib/chatRooms";
import {
  CHAT_TOKEN_TTL_SEC,
  canonicalChatTokenPayload,
  parseChatTokenClaims,
  signChatToken,
  verifyChatToken,
} from "../src/lib/chatToken";
import { SUPER_ADMIN_USERNAME } from "../src/lib/staffAdminAccounts";

process.env.CHAT_AUTH_SECRET = "phase1-local-test-only";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "phase1-session-test";

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

async function main() {
section("legacy room mapping kept");
{
  assert(teamToChatRoomId("1조") === "team-1", "1조 → team-1");
  assert(teamToChatRoomId("12조") === "team-12", "12조 → team-12");
  assert(teamToChatRoomId("드라이빙") == null, "driving not a legacy team room");
  assert(chatRoomIdToTeam("team-3") === "3조", "team-3 → 3조");
  assert(isChatRoomId("team-12"), "team-12 valid legacy");
  assert(!isChatRoomId("poc-room"), "legacy poc-room rejected");
  assert(!isChatRoomId("team:1조"), "colon+hangul room rejected");
  assert(isCustomRoomId("room_0123456789abcdef"), "custom room id");
}

section("eligibility");
{
  const caddy = { id: 7, name: "홍길동", team: "1조", employmentStatus: "ACTIVE" };
  const ok = resolveChatEligibility({
    userId: 9,
    username: "hong",
    role: "caddy",
    caddyId: 7,
    caddy,
  });
  assert(ok.ok && ok.value.userId === 9, "caddy identity");
  assert(ok.ok && ok.value.displayName === "홍길동", "display from caddy.name");
  assert(ok.ok && !("roomId" in ok.value), "eligibility is identity, not a team room");

  const leader = resolveChatEligibility({
    userId: 8,
    username: "lead",
    role: "leader",
    caddyId: 7,
    caddy: { ...caddy, team: "2조" },
  });
  assert(leader.ok && leader.value.team === "2조", "leader uses Caddy.team not managedTeams");

  const unlinked = resolveChatEligibility({
    userId: 9,
    username: "hong",
    role: "caddy",
    caddyId: null,
    caddy: null,
  });
  assert(!unlinked.ok && unlinked.code === "caddy_not_linked", "unlinked caddy");

  const envOnly = resolveChatEligibility({
    userId: null,
    username: "admin",
    role: "admin",
    caddyId: null,
    caddy: null,
  });
  assert(!envOnly.ok && envOnly.code === "chat_user_required", "env-only no chat");

  const driving = resolveChatEligibility({
    userId: 3,
    username: "d",
    role: "caddy",
    caddyId: 1,
    caddy: { id: 1, name: "D", team: "드라이빙", employmentStatus: "ACTIVE" },
  });
  assert(driving.ok && driving.value.team === "드라이빙", "non-primary team still gets identity");

  const dbAdmin = resolveChatEligibility({
    userId: 1,
    username: "park",
    role: "admin",
    caddyId: null,
    caddy: null,
  });
  assert(dbAdmin.ok && dbAdmin.value.role === "admin", "DB admin without caddy");

  const retired = resolveChatEligibility({
    userId: 9,
    username: "hong",
    role: "caddy",
    caddyId: 7,
    caddy: { id: 7, name: "홍길동", team: "1조", employmentStatus: "RETIRED" },
  });
  assert(!retired.ok && retired.code === "caddy_retired", "retired blocked from new token");
  assert(CHAT_TOKEN_TTL_SEC === 1800, "TTL 30 min after eligibility re-check");
}

section("token hmac v2 + v1 compat");
{
  const now = 1_700_000_000;
  const v2 = {
    v: 2 as const,
    userId: 9,
    displayName: "홍길동",
    role: "caddy" as const,
    team: "1조",
    iat: now,
    exp: now + CHAT_TOKEN_TTL_SEC,
  };
  const token = await signChatToken(v2);
  const verified = await verifyChatToken(token, { nowSec: now + 10 });
  assert(verified?.v === 2 && verified.userId === 9, "v2 sign/verify");
  const expired = await verifyChatToken(token, { nowSec: v2.exp + 1 });
  assert(expired == null, "expired rejected");
  const other = await verifyChatToken(token, {
    secret: "wrong-secret",
    nowSec: now + 10,
  });
  assert(other == null, "wrong secret rejected");
  const canonical = canonicalChatTokenPayload(v2);
  const nodeSig = createHmac("sha256", "phase1-local-test-only")
    .update(canonical)
    .digest("base64url");
  const body = Buffer.from(canonical, "utf8").toString("base64url");
  const nodeToken = `${body}.${nodeSig}`;
  const cross = await verifyChatToken(nodeToken, { nowSec: now + 10 });
  assert(cross?.displayName === "홍길동" && cross.v === 2, "node hmac interoperable v2");
  assert(parseChatTokenClaims(canonical)?.v === 2, "parse v2 canonical");

  const v1 = {
    v: 1 as const,
    userId: 9,
    displayName: "홍길동",
    role: "caddy" as const,
    team: "1조",
    room: "team-1",
    iat: now,
    exp: now + CHAT_TOKEN_TTL_SEC,
  };
  const v1tok = await signChatToken(v1);
  const v1ok = await verifyChatToken(v1tok, { nowSec: now + 10 });
  assert(v1ok?.v === 1 && v1ok.room === "team-1", "v1 backward compatible verify");
}

section("ACL");
{
  const v2 = {
    v: 2 as const,
    userId: 9,
    displayName: "홍길동",
    role: "caddy" as const,
    team: "1조",
    iat: 1,
    exp: 9,
  };
  const v1 = {
    v: 1 as const,
    userId: 9,
    displayName: "홍길동",
    role: "caddy" as const,
    team: "1조",
    room: "team-1",
    iat: 1,
    exp: 9,
  };
  assert(resolveChatRoomAccess({ claims: v2, roomId: "all", isMember: false }).ok, "v2 all room");
  assert(
    !resolveChatRoomAccess({ claims: v2, roomId: "room_0123456789abcdef", isMember: false }).ok,
    "v2 non-member custom 403"
  );
  assert(
    resolveChatRoomAccess({ claims: v2, roomId: "room_0123456789abcdef", isMember: true }).ok,
    "v2 member custom"
  );
  assert(
    !resolveChatRoomAccess({ claims: v1, roomId: "all", isMember: false }).ok,
    "v1 cannot enter overall room"
  );
  assert(
    resolveChatRoomAccess({ claims: v1, roomId: "team-1", isMember: false }).ok,
    "v1 still enters own legacy team room"
  );
  assert(
    !resolveChatRoomAccess({ claims: v1, roomId: "team-2", isMember: false }).ok,
    "v1 cross-room forbidden"
  );
}

section("issue identity token");
{
  const auth = {
    userId: 8,
    username: "lead",
    role: "leader",
    caddyId: 22,
    managedTeams: ["9조"],
    sessionVersion: 1,
    mustChangePassword: false,
    session: {} as ResolvedAuthUser["session"],
  } as ResolvedAuthUser;
  const issued = await issueChatAccessToken(
    {
      user: {
        async findUnique() {
          throw new Error("DB-backed token must not map env admin");
        },
      },
      caddy: {
        async findUnique() {
          return { id: 22, name: "조장", team: "1조", employmentStatus: "ACTIVE" };
        },
      },
    },
    auth,
    1_700_000_000
  );
  assert(!("room" in issued), "issued token is identity, not room-bound");
  assert(issued.user.displayName === "조장", "issued displayName");
  const verified = await verifyChatToken(issued.token, { nowSec: 1_700_000_010 });
  assert(verified?.v === 2 && verified.userId === 8 && verified.team === "1조", "issued v2 verifies");
}

section("POST /api/chat/token");
{
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../src/app/api/chat/token/route");
  const { prisma } = await import("../src/lib/prisma");
  const {
    SESSION_COOKIE_NAME,
    buildSessionClaims,
    signSessionClaims,
  } = await import("../src/lib/sessionCookies");

  async function cookieFor(user: {
    id: number | null;
    username: string;
    role: "admin" | "caddy" | "leader";
    sessionVersion: number;
  }) {
    return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
      buildSessionClaims({
        userId: user.id,
        username: user.username,
        role: user.role,
        sessionVersion: user.sessionVersion,
      })
    )}`;
  }

  const envCookie = await cookieFor({
    id: null,
    username: "admin",
    role: "admin",
    sessionVersion: 0,
  });
  const prevAdminChatUserId = process.env.ADMIN_CHAT_USER_ID;
  delete process.env.ADMIN_CHAT_USER_ID;
  const origUserForEnv = prisma.user.findUnique.bind(prisma.user);
  prisma.user.findUnique = (async () => null) as typeof prisma.user.findUnique;
  try {
    const envRes = await POST(
      new NextRequest("http://127.0.0.1/api/chat/token", {
        method: "POST",
        headers: { cookie: envCookie },
      })
    );
    const envBody = await envRes.json();
    assert(
      envRes.status === 403 && envBody.error === "chat_admin_user_missing",
      "env-only admin without mapping rejected"
    );
  } finally {
    prisma.user.findUnique = origUserForEnv;
    if (prevAdminChatUserId == null) delete process.env.ADMIN_CHAT_USER_ID;
    else process.env.ADMIN_CHAT_USER_ID = prevAdminChatUserId;
  }

  const origUser = prisma.user.findUnique.bind(prisma.user);
  const origCaddy = prisma.caddy.findUnique.bind(prisma.caddy);
  prisma.user.findUnique = (async () => ({
    id: 9,
    username: "hong",
    role: "caddy",
    sessionVersion: 1,
    caddyId: 7,
    managedTeams: ["9조"],
    mustChangePassword: false,
    caddy: { employmentStatus: "ACTIVE" },
  })) as typeof prisma.user.findUnique;
  prisma.caddy.findUnique = (async () => ({
    id: 7,
    name: "홍길동",
    team: "1조",
    employmentStatus: "ACTIVE",
  })) as typeof prisma.caddy.findUnique;
  try {
    const cookie = await cookieFor({
      id: 9,
      username: "hong",
      role: "caddy",
      sessionVersion: 1,
    });
    const res = await POST(
      new NextRequest("http://127.0.0.1/api/chat/token", {
        method: "POST",
        headers: { cookie },
      })
    );
    const body = await res.json();
    assert(res.status === 200 && body.user.userId === 9, "caddy identity token");
    assert(body.user.displayName === "홍길동", "token displayName from caddy");
    assert(!body.room, "token response has no bound team room");
    assert(typeof body.token === "string" && !String(body.token).includes("vh_session"), "no session leak");

    prisma.caddy.findUnique = (async () => null) as typeof prisma.caddy.findUnique;
    const unlinked = await POST(
      new NextRequest("http://127.0.0.1/api/chat/token", {
        method: "POST",
        headers: { cookie },
      })
    );
    const unlinkedBody = await unlinked.json();
    assert(unlinked.status === 403 && unlinkedBody.error === "caddy_not_linked", "unlinked rejected");

    prisma.user.findUnique = (async () => ({
      id: 1,
      username: "park",
      role: "admin",
      sessionVersion: 1,
      caddyId: null,
      managedTeams: [],
      mustChangePassword: false,
      caddy: null,
    })) as typeof prisma.user.findUnique;
    const adminCookie = await cookieFor({
      id: 1,
      username: "park",
      role: "admin",
      sessionVersion: 1,
    });
    const adminRes = await POST(
      new NextRequest("http://127.0.0.1/api/chat/token", {
        method: "POST",
        headers: { cookie: adminCookie },
      })
    );
    const adminBody = await adminRes.json();
    assert(adminRes.status === 200 && adminBody.user.userId === 1, "DB-backed admin token");
    assert(adminBody.user.role === "admin", "admin role is server verified");
  } finally {
    prisma.user.findUnique = origUser;
    prisma.caddy.findUnique = origCaddy;
  }
}

section("GET /api/chat/users");
{
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../src/app/api/chat/users/route");
  const { prisma } = await import("../src/lib/prisma");
  const {
    SESSION_COOKIE_NAME,
    buildSessionClaims,
    signSessionClaims,
  } = await import("../src/lib/sessionCookies");

  const unauth = await GET(new NextRequest("http://127.0.0.1/api/chat/users?scope=all"));
  const unauthBody = await unauth.json();
  assert(unauth.status === 401 && unauthBody.error === "unauthorized", "unauth scope=all rejected");

  const origUser = prisma.user.findUnique.bind(prisma.user);
  const origCaddy = prisma.caddy.findUnique.bind(prisma.caddy);
  const origFindMany = prisma.user.findMany.bind(prisma.user);
  prisma.user.findUnique = (async () => ({
    id: 1,
    username: "park",
    role: "admin",
    sessionVersion: 1,
    caddyId: null,
    managedTeams: [],
    mustChangePassword: false,
    caddy: null,
  })) as typeof prisma.user.findUnique;
  prisma.caddy.findUnique = (async () => null) as typeof prisma.caddy.findUnique;
  prisma.user.findMany = (async () => [
    { id: 2, username: "kim", role: "caddy", caddy: { name: "김OO", team: "2조", employmentStatus: "ACTIVE" } },
    { id: 3, username: "out", role: "caddy", caddy: { name: "퇴직", team: "3조", employmentStatus: "RETIRED" } },
    { id: 4, username: "admin", role: "admin", caddy: null },
  ]) as typeof prisma.user.findMany;
  try {
    const cookie = `${SESSION_COOKIE_NAME}=${await signSessionClaims(
      buildSessionClaims({
        userId: 1,
        username: "park",
        role: "admin",
        sessionVersion: 1,
      })
    )}`;
    const empty = await GET(
      new NextRequest("http://127.0.0.1/api/chat/users?q=", { headers: { cookie } })
    );
    const emptyBody = await empty.json();
    assert(empty.status === 200 && Array.isArray(emptyBody.users) && emptyBody.users.length === 0, "empty q still []");

    const all = await GET(
      new NextRequest("http://127.0.0.1/api/chat/users?scope=all", { headers: { cookie } })
    );
    const allBody = await all.json();
    assert(all.status === 200 && allBody.users.length === 2, "scope=all returns invitable only");
    assert(
      allBody.users.every(
        (u: { phone?: unknown; kakaoUserId?: unknown }) =>
          !("phone" in u) && !("kakaoUserId" in u)
      ),
      "scope=all has no sensitive fields"
    );
    assert(
      allBody.users.some((u: { role: string }) => u.role === "admin"),
      "DB admin is invitable"
    );
    assert(
      !allBody.users.some((u: { displayName: string }) => u.displayName === "퇴직"),
      "retired excluded from scope=all"
    );
  } finally {
    prisma.user.findUnique = origUser;
    prisma.caddy.findUnique = origCaddy;
    prisma.user.findMany = origFindMany;
  }
}

section("env-admin chat identity mapping");
{
  const prev = process.env.ADMIN_CHAT_USER_ID;
  delete process.env.ADMIN_CHAT_USER_ID;

  assert(parseAdminChatUserId("").status === "unset", "empty mapping unset");
  assert(parseAdminChatUserId("  ").status === "unset", "blank mapping unset");
  assert(parseAdminChatUserId("12").status === "ok" && parseAdminChatUserId("12").status === "ok" && (parseAdminChatUserId("12") as { userId: number }).userId === 12, "explicit id parsed");
  assert(parseAdminChatUserId("0").status === "invalid", "zero id invalid");
  assert(parseAdminChatUserId("-3").status === "invalid", "negative id invalid");
  assert(parseAdminChatUserId("1.5").status === "invalid", "float id invalid");
  assert(parseAdminChatUserId("admin").status === "invalid", "username is not an id");
  assert(SUPER_ADMIN_USERNAME === "admin", "default map target is dedicated admin");

  const adminRow = {
    id: 41,
    username: "admin",
    role: "admin",
    caddyId: null,
    caddy: null,
  };
  const staffRow = {
    id: 21,
    username: "박성민",
    role: "admin",
    caddyId: null,
    caddy: null,
  };
  const caddyRow = {
    id: 9,
    username: "hong",
    role: "caddy",
    caddyId: 7,
    caddy: { id: 7, name: "홍길동", team: "1조", employmentStatus: "ACTIVE" },
  };

  function lookupDb(rows: typeof adminRow[]) {
    return {
      user: {
        async findUnique({ where }: { where: { id?: number; username?: string } }) {
          if ("id" in where && where.id != null) {
            return rows.find((r) => r.id === where.id) ?? null;
          }
          if ("username" in where && where.username != null) {
            return rows.find((r) => r.username === where.username) ?? null;
          }
          return null;
        },
      },
      caddy: {
        async findUnique() {
          return null;
        },
      },
    };
  }

  const defaultMap = await resolveEnvAdminChatIdentity(lookupDb([adminRow, staffRow]));
  assert(defaultMap.ok && defaultMap.value.userId === 41, "default maps dedicated admin id");
  assert(defaultMap.ok && defaultMap.value.username === "admin", "default maps admin username");

  const missing = await resolveEnvAdminChatIdentity(lookupDb([staffRow]));
  assert(!missing.ok && missing.code === "chat_admin_user_missing", "missing dedicated admin rejected");

  const nonAdminNamedAdmin = await resolveEnvAdminChatIdentity(
    lookupDb([{ ...adminRow, role: "caddy" }])
  );
  assert(
    !nonAdminNamedAdmin.ok && nonAdminNamedAdmin.code === "chat_admin_mapping_invalid",
    "username admin without admin role rejected"
  );

  process.env.ADMIN_CHAT_USER_ID = "21";
  const explicit = await resolveEnvAdminChatIdentity(lookupDb([adminRow, staffRow]));
  assert(explicit.ok && explicit.value.userId === 21, "ADMIN_CHAT_USER_ID wins");
  assert(explicit.ok && explicit.value.username === "박성민", "explicit id uses that User");

  process.env.ADMIN_CHAT_USER_ID = "9";
  const spoofCaddy = await resolveEnvAdminChatIdentity(lookupDb([adminRow, caddyRow]));
  assert(!spoofCaddy.ok && spoofCaddy.code === "chat_admin_mapping_invalid", "cannot map to caddy User");

  process.env.ADMIN_CHAT_USER_ID = "99";
  const missingId = await resolveEnvAdminChatIdentity(lookupDb([adminRow]));
  assert(!missingId.ok && missingId.code === "chat_admin_user_missing", "missing mapped id rejected");

  process.env.ADMIN_CHAT_USER_ID = "nope";
  const badEnv = await resolveEnvAdminChatIdentity(lookupDb([adminRow]));
  assert(!badEnv.ok && badEnv.code === "chat_admin_mapping_invalid", "invalid ADMIN_CHAT_USER_ID rejected");

  delete process.env.ADMIN_CHAT_USER_ID;

  const envAdminAuth = {
    userId: null,
    username: "env-operator",
    role: "admin",
    caddyId: null,
    managedTeams: [],
    sessionVersion: 0,
    mustChangePassword: false,
    session: {} as ResolvedAuthUser["session"],
  } as ResolvedAuthUser;

  const issued = await issueChatAccessToken(lookupDb([adminRow]), envAdminAuth, 1_700_000_000);
  assert(issued.user.userId === 41, "env-admin token uses mapped userId");
  assert(issued.user.role === "admin", "env-admin token role is admin");
  assert(issued.ttlSec === 1800, "mapped token keeps 30m TTL");
  const again = await issueChatAccessToken(lookupDb([adminRow]), envAdminAuth, 1_700_000_100);
  assert(again.user.userId === issued.user.userId, "mapped userId is stable");
  const verified = await verifyChatToken(issued.token, { nowSec: 1_700_000_010 });
  assert(verified?.userId === 41 && verified.role === "admin" && verified.v === 2, "mapped claims verify");

  const envCaddyAuth = { ...envAdminAuth, role: "caddy" as const, username: "caddy" };
  let envCaddyCode = "";
  try {
    await issueChatAccessToken(lookupDb([adminRow]), envCaddyAuth, 1_700_000_000);
  } catch (e) {
    envCaddyCode = e instanceof ChatAuthError ? e.code : "other";
  }
  assert(envCaddyCode === "chat_user_required", "env-only caddy cannot take admin identity");

  const dbAdminAuth = {
    userId: 21,
    username: "박성민",
    role: "admin" as const,
    caddyId: null,
    managedTeams: [],
    sessionVersion: 1,
    mustChangePassword: false,
    session: {} as ResolvedAuthUser["session"],
  } as ResolvedAuthUser;
  const dbIssued = await issueChatAccessToken(
    {
      user: {
        async findUnique() {
          throw new Error("DB-backed admin must not remap");
        },
      },
      caddy: { async findUnique() { return null; } },
    },
    dbAdminAuth,
    1_700_000_000
  );
  assert(dbIssued.user.userId === 21 && dbIssued.user.role === "admin", "DB-backed admin path unchanged");

  const ownerRows: ChatUserRow[] = [
    { id: 2, username: "kim", role: "caddy", caddy: { name: "김OO", team: "2조", employmentStatus: "ACTIVE" } },
    { id: 41, username: "admin", role: "admin", caddy: null },
  ];
  const room = collectChatInviteMembers({
    owner: {
      userId: issued.user.userId,
      displayName: issued.user.displayName,
      role: issued.user.role,
      team: issued.user.team,
    },
    candidates: ownerRows,
    requestedIds: [2],
  });
  assert(room.ok && room.ok && room.members[0]?.userId === 41, "mapped admin is room owner");
  assert(room.ok && room.members.some((m) => m.userId === 2), "mapped admin can invite");
  assert(
    listInvitableChatUsers(ownerRows).some((u) => u.userId === 41 && u.role === "admin"),
    "mapped admin is directory-compatible"
  );
  assert(
    resolveChatRoomAccess({
      claims: {
        v: 2,
        userId: issued.user.userId,
        displayName: issued.user.displayName,
        role: issued.user.role,
        team: issued.user.team,
        iat: 1,
        exp: 9,
      },
      roomId: "all",
      isMember: false,
    }).ok,
    "mapped admin can open overall room"
  );

  if (prev == null) delete process.env.ADMIN_CHAT_USER_ID;
  else process.env.ADMIN_CHAT_USER_ID = prev;
}

section("POST /api/chat/token env-admin mapped + spoof");
{
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../src/app/api/chat/token/route");
  const { prisma } = await import("../src/lib/prisma");
  const {
    SESSION_COOKIE_NAME,
    buildSessionClaims,
    signSessionClaims,
  } = await import("../src/lib/sessionCookies");

  async function cookieFor(user: {
    id: number | null;
    username: string;
    role: "admin" | "caddy" | "leader";
    sessionVersion: number;
  }) {
    return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
      buildSessionClaims({
        userId: user.id,
        username: user.username,
        role: user.role,
        sessionVersion: user.sessionVersion,
      })
    )}`;
  }

  const prev = process.env.ADMIN_CHAT_USER_ID;
  delete process.env.ADMIN_CHAT_USER_ID;
  const origUser = prisma.user.findUnique.bind(prisma.user);
  const origCaddy = prisma.caddy.findUnique.bind(prisma.caddy);
  prisma.user.findUnique = (async (args: { where?: { id?: number; username?: string } }) => {
    if (args?.where?.username === "admin" || args?.where?.id === 41) {
      return {
        id: 41,
        username: "admin",
        role: "admin",
        sessionVersion: 0,
        caddyId: null,
        managedTeams: [],
        mustChangePassword: false,
        caddy: null,
      };
    }
    if (args?.where?.id === 9 || args?.where?.username === "hong") {
      return {
        id: 9,
        username: "hong",
        role: "caddy",
        sessionVersion: 1,
        caddyId: 7,
        managedTeams: [],
        mustChangePassword: false,
        caddy: { employmentStatus: "ACTIVE" },
      };
    }
    return null;
  }) as typeof prisma.user.findUnique;
  prisma.caddy.findUnique = (async () => ({
    id: 7,
    name: "홍길동",
    team: "1조",
    employmentStatus: "ACTIVE",
  })) as typeof prisma.caddy.findUnique;

  try {
    const envCookie = await cookieFor({
      id: null,
      username: "admin",
      role: "admin",
      sessionVersion: 0,
    });
    const envRes = await POST(
      new NextRequest("http://127.0.0.1/api/chat/token", {
        method: "POST",
        headers: { cookie: envCookie },
        body: JSON.stringify({ userId: 9, role: "admin" }),
      })
    );
    const envBody = await envRes.json();
    assert(envRes.status === 200 && envBody.user.userId === 41, "env-admin session issues mapped token");
    assert(envBody.user.role === "admin", "mapped token role is server admin");
    assert(envBody.ttlSec === 1800, "HTTP mapped token TTL 30m");
    assert(envBody.user.userId !== 9, "client userId body cannot spoof mapping");

    const caddyCookie = await cookieFor({
      id: 9,
      username: "hong",
      role: "caddy",
      sessionVersion: 1,
    });
    const caddyRes = await POST(
      new NextRequest("http://127.0.0.1/api/chat/token", {
        method: "POST",
        headers: { cookie: caddyCookie },
        body: JSON.stringify({ userId: 41, role: "admin" }),
      })
    );
    const caddyBody = await caddyRes.json();
    assert(caddyRes.status === 200 && caddyBody.user.userId === 9, "caddy keeps own userId");
    assert(caddyBody.user.role === "caddy", "caddy cannot spoof admin role");

    const { GET } = await import("../src/app/api/chat/users/route");
    const origFindMany = prisma.user.findMany.bind(prisma.user);
    prisma.user.findMany = (async () => [
      { id: 2, username: "kim", role: "caddy", caddy: { name: "김OO", team: "2조", employmentStatus: "ACTIVE" } },
      { id: 41, username: "admin", role: "admin", caddy: null },
    ]) as typeof prisma.user.findMany;
    try {
      const usersRes = await GET(
        new NextRequest("http://127.0.0.1/api/chat/users?scope=all", {
          headers: { cookie: envCookie },
        })
      );
      const usersBody = await usersRes.json();
      assert(usersRes.status === 200 && usersBody.users.length === 2, "mapped env-admin can list directory");
    } finally {
      prisma.user.findMany = origFindMany;
    }

    process.env.ADMIN_CHAT_USER_ID = "9";
    const badMap = await POST(
      new NextRequest("http://127.0.0.1/api/chat/token", {
        method: "POST",
        headers: { cookie: envCookie },
      })
    );
    const badMapBody = await badMap.json();
    assert(
      badMap.status === 403 && badMapBody.error === "chat_admin_mapping_invalid",
      "env-admin cannot map onto caddy User"
    );
  } finally {
    prisma.user.findUnique = origUser;
    prisma.caddy.findUnique = origCaddy;
    if (prev == null) delete process.env.ADMIN_CHAT_USER_ID;
    else process.env.ADMIN_CHAT_USER_ID = prev;
  }
}

if (failed > 0) {
  console.error(`\nchat-token tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nchat-token tests passed: ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
