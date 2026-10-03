/**
 * Chat Phase 1 token / eligibility / room mapping.
 * 실행: npm run test:chat-token-unit
 */
import { createHmac } from "node:crypto";
import { issueChatAccessToken, resolveChatEligibility } from "../src/lib/chatAuth";
import type { ResolvedAuthUser } from "../src/lib/auth";
import { chatRoomIdToTeam, isChatRoomId, teamToChatRoomId } from "../src/lib/chatRooms";
import {
  CHAT_TOKEN_TTL_SEC,
  canonicalChatTokenPayload,
  parseChatTokenClaims,
  signChatToken,
  verifyChatToken,
} from "../src/lib/chatToken";

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
section("room mapping");
{
  assert(teamToChatRoomId("1조") === "team-1", "1조 → team-1");
  assert(teamToChatRoomId("12조") === "team-12", "12조 → team-12");
  assert(teamToChatRoomId("드라이빙") == null, "driving not a chat room");
  assert(chatRoomIdToTeam("team-3") === "3조", "team-3 → 3조");
  assert(isChatRoomId("team-12"), "team-12 valid");
  assert(!isChatRoomId("poc-room"), "legacy poc-room rejected");
  assert(!isChatRoomId("team:1조"), "colon+hangul room rejected");
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
  assert(ok.ok && ok.value.roomId === "team-1", "caddy own team");
  assert(ok.ok && ok.value.displayName === "홍길동", "display from caddy.name");

  const leader = resolveChatEligibility({
    userId: 8,
    username: "lead",
    role: "leader",
    caddyId: 7,
    caddy: { ...caddy, team: "2조" },
  });
  assert(leader.ok && leader.value.roomId === "team-2", "leader uses Caddy.team not managedTeams");

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
  assert(!driving.ok && driving.code === "no_primary_team", "driving no primary room");
}

section("token hmac");
{
  const now = 1_700_000_000;
  const claims = {
    v: 1 as const,
    userId: 9,
    displayName: "홍길동",
    role: "caddy" as const,
    team: "1조",
    room: "team-1",
    iat: now,
    exp: now + CHAT_TOKEN_TTL_SEC,
  };
  const token = await signChatToken(claims);
  const verified = await verifyChatToken(token, { nowSec: now + 10 });
  assert(verified?.userId === 9 && verified.room === "team-1", "sign/verify");
  const expired = await verifyChatToken(token, { nowSec: claims.exp + 1 });
  assert(expired == null, "expired rejected");
  const other = await verifyChatToken(token, {
    secret: "wrong-secret",
    nowSec: now + 10,
  });
  assert(other == null, "wrong secret rejected");
  const canonical = canonicalChatTokenPayload(claims);
  const nodeSig = createHmac("sha256", "phase1-local-test-only")
    .update(canonical)
    .digest("base64url");
  const body = Buffer.from(canonical, "utf8").toString("base64url");
  const nodeToken = `${body}.${nodeSig}`;
  const cross = await verifyChatToken(nodeToken, { nowSec: now + 10 });
  assert(cross?.displayName === "홍길동", "node hmac interoperable");
  assert(parseChatTokenClaims(canonical)?.room === "team-1", "parse canonical");
}

section("issue token uses Caddy.team");
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
      caddy: {
        async findUnique() {
          return { id: 22, name: "조장", team: "1조", employmentStatus: "ACTIVE" };
        },
      },
    },
    auth,
    1_700_000_000
  );
  assert(issued.room.id === "team-1", "leader room from Caddy.team not managedTeams");
  assert(issued.user.displayName === "조장", "issued displayName");
  const verified = await verifyChatToken(issued.token, { nowSec: 1_700_000_010 });
  assert(verified?.room === "team-1" && verified.userId === 8, "issued token verifies");
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
  const envRes = await POST(
    new NextRequest("http://127.0.0.1/api/chat/token", {
      method: "POST",
      headers: { cookie: envCookie },
    })
  );
  const envBody = await envRes.json();
  assert(envRes.status === 403 && envBody.error === "chat_user_required", "env-only rejected");

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
    assert(res.status === 200 && body.room.id === "team-1", "caddy token own team");
    assert(body.user.displayName === "홍길동", "token displayName from caddy");
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
  } finally {
    prisma.user.findUnique = origUser;
    prisma.caddy.findUnique = origCaddy;
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
