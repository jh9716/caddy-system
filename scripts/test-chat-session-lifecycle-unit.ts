/**
 * Chat token/session lifecycle (PR1).
 * 실행: npm run test:chat-session-lifecycle-unit
 * Local helpers + mocked Next only. No production DB/Worker.
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import { NextRequest } from "next/server";
import {
  CHAT_TOKEN_TTL_SEC,
  canonicalChatTokenPayload,
  parseChatTokenClaims,
  signChatToken,
  verifyChatToken,
} from "../src/lib/chatToken";
import {
  evaluateChatSessionEpoch,
  isChatSessionEpochStale,
} from "../src/lib/chatSessionEpoch";
import {
  CHAT_SESSION_CHECK_PATH,
  CHAT_SESSION_REVOKE_PATH,
  notifyChatSessionRevoked,
} from "../src/lib/chatSessionRevoke";
import {
  clearChatSessionEnded,
  isChatSessionEnded,
  markChatSessionEnded,
  requestChatSessionReset,
  resetChatSocketHandles,
  shouldAttemptChatReconnect,
} from "../src/lib/chatSessionReset";
import {
  CHAT_INTERNAL_AUTH_HEADER,
  CHAT_INTERNAL_TS_HEADER,
  signChatInternalAuth,
} from "../src/lib/chatInternalAuth";
import { ChatAuthError, issueChatAccessToken } from "../src/lib/chatAuth";
import type { ResolvedAuthUser } from "../src/lib/auth";
import { TOKEN_EXPIRED_CLOSE, shouldRefreshTokenOnClose } from "../src/lib/chatReconnect";

process.env.CHAT_AUTH_SECRET = process.env.CHAT_AUTH_SECRET || "phase1-local-test-only";
process.env.CHAT_INTERNAL_SECRET = process.env.CHAT_INTERNAL_SECRET || "phase1-local-test-only";
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

function read(rel: string) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function closedSocket() {
  let closed = 0;
  return {
    close() {
      closed += 1;
    },
    get closed() {
      return closed;
    },
  };
}

async function main() {
  clearChatSessionEnded();

  section("1. signed sv claim + tamper");
  {
    const now = 1_700_000_000;
    const claims = {
      v: 2 as const,
      userId: 9,
      displayName: "홍길동",
      role: "caddy" as const,
      team: "1조",
      sv: 3,
      iat: now,
      exp: now + CHAT_TOKEN_TTL_SEC,
    };
    const token = await signChatToken(claims);
    const verified = await verifyChatToken(token, { nowSec: now + 1 });
    assert(verified?.v === 2 && verified.sv === 3, "v2 token includes sessionVersion");
    const canonical = canonicalChatTokenPayload(claims);
    assert(canonical === "2|9|홍길동|caddy|1조|3|1700000000|1700001800", "canonical 8-part binds sv");
    assert(parseChatTokenClaims("2|9|홍길동|caddy|1조|1700000000|1700001800") == null, "7-part v2 rejected");
    const parts = canonical.split("|");
    parts[5] = "4";
    const tampered = `${Buffer.from(parts.join("|"), "utf8").toString("base64url")}.${createHmac(
      "sha256",
      process.env.CHAT_AUTH_SECRET || ""
    )
      .update(canonical)
      .digest("base64url")}`;
    assert((await verifyChatToken(tampered, { nowSec: now + 1 })) == null, "sv tamper fails HMAC");
    assert(CHAT_TOKEN_TTL_SEC === 1800, "TTL remains 30 min — max stale window if notify fails");
  }

  section("2/3. sessionVersion exact match (fail-closed)");
  {
    assert(evaluateChatSessionEpoch({ tokenSv: 2, currentSv: 2 }).ok, "current sv allowed");
    assert(
      evaluateChatSessionEpoch({ tokenSv: 1, currentSv: 2 }).ok === false &&
        evaluateChatSessionEpoch({ tokenSv: 1, currentSv: 2 }).ok === false,
      "stale sv rejected"
    );
    const stale = evaluateChatSessionEpoch({ tokenSv: 1, currentSv: 2 });
    assert(!stale.ok && stale.code === "stale_session", "stale code");
    const missing = evaluateChatSessionEpoch({ tokenSv: 2, currentSv: null });
    assert(!missing.ok && missing.code === "user_unavailable", "missing current sv fail-closed");
    const badToken = evaluateChatSessionEpoch({ tokenSv: "x", currentSv: 1 });
    assert(!badToken.ok && badToken.code === "user_unavailable", "bad token sv fail-closed");
    const retired = evaluateChatSessionEpoch({
      tokenSv: 2,
      currentSv: 2,
      chatBlocked: true,
    });
    assert(!retired.ok && retired.code === "user_unavailable", "RETIRED blocks even matching sv");
    assert(isChatSessionEpochStale(1, 2) === true, "open-socket cache: stored > token is stale");
    assert(isChatSessionEpochStale(2, 2) === false, "open-socket cache: equal is live");
    assert(isChatSessionEpochStale(1, null) === false, "open-socket cache: missing is unknown, not instant revoke");
    assert(isChatSessionEpochStale(null, 2) === true, "v1 token stale only after epoch is stored");
    assert(isChatSessionEpochStale(null, null) === false, "v1 without store stays until TTL");
  }

  section("4/5. logout closes sockets and cancels reconnect");
  {
    const room = closedSocket();
    const dir = closedSocket();
    const roomTimer = { current: 11 as number | null };
    const dirTimer = { current: 22 as number | null };
    const handles = {
      roomGenRef: { current: 3 },
      dirGenRef: { current: 4 },
      roomTimerRef: roomTimer,
      dirTimerRef: dirTimer,
      wsRef: { current: room as unknown as WebSocket },
      dirRef: { current: dir as unknown as WebSocket },
      tokenRef: { current: { token: "old-a" } },
      reconnectingRef: { current: true },
    };
    resetChatSocketHandles(handles);
    assert(handles.roomGenRef.current === 4 && handles.dirGenRef.current === 5, "generations bumped");
    assert(handles.tokenRef.current == null, "tokenRef cleared");
    assert(handles.wsRef.current == null && handles.dirRef.current == null, "socket refs cleared");
    assert(room.closed === 1 && dir.closed === 1, "room + directory sockets closed");
    assert(roomTimer.current == null && dirTimer.current == null, "reconnect timers cancelled");
    assert(handles.reconnectingRef.current === false, "reconnecting flag cleared");
    markChatSessionEnded();
    assert(
      shouldAttemptChatReconnect({
        generationMatches: true,
        hasToken: true,
        sessionEnded: true,
      }) === false,
      "logout does not reconnect"
    );
    assert(
      shouldAttemptChatReconnect({
        generationMatches: false,
        hasToken: true,
      }) === false,
      "stale generation cannot reconnect"
    );
    clearChatSessionEnded();
  }

  section("6. account switch drops old token");
  {
    clearChatSessionEnded();
    const old = closedSocket();
    const handles = {
      roomGenRef: { current: 1 },
      dirGenRef: { current: 1 },
      roomTimerRef: { current: null as number | null },
      dirTimerRef: { current: null as number | null },
      wsRef: { current: old as unknown as WebSocket },
      dirRef: { current: null as WebSocket | null },
      tokenRef: { current: { token: "account-a" } },
    };
    resetChatSocketHandles(handles);
    requestChatSessionReset("account_switch");
    assert(handles.tokenRef.current == null, "A token removed");
    assert(old.closed === 1, "A socket closed");
    assert(isChatSessionEnded() === false, "account switch allows B to fetch a new token");
  }

  section("7/8/9. logout-all / password / RETIRED notify after sv bump");
  {
    const logoutAll = read("src/app/api/auth/logout-all/route.ts");
    const changePw = read("src/app/api/auth/change-password/route.ts");
    const resetPw = read("src/app/api/admin/staff-accounts/[id]/reset-password/route.ts");
    const retired = read("src/lib/sessionRevocation.ts");
    const unlink = read("src/lib/userCaddyLink.ts");
    const logoutClient = read("src/lib/logoutClient.ts");
    const login = read("src/app/login/LoginClient.tsx");
    const chat = read("src/app/chat/ChatClient.tsx");
    const worker = read("cloudflare/verthill-chat/src/index.ts");
    const sessionCheck = read("cloudflare/verthill-chat/src/sessionCheck.ts");
    assert(logoutAll.includes("sessionVersion: { increment: 1 }"), "logout-all bumps sv");
    assert(logoutAll.includes("notifyChatSessionRevoked"), "logout-all fans out revoke");
    assert(changePw.includes("sessionVersion: { increment: 1 }"), "password change bumps sv");
    assert(changePw.includes("notifyChatSessionRevoked"), "password change fans out revoke");
    assert(resetPw.includes("sessionVersion: { increment: 1 }"), "password reset bumps sv");
    assert(resetPw.includes("notifyChatSessionRevoked"), "password reset fans out revoke");
    assert(retired.includes("incrementSessionVersionForCaddyLink"), "RETIRED bumps linked sv");
    assert(retired.includes("notifyChatSessionRevokedForCaddyLink"), "RETIRED fans out after commit");
    assert(unlink.includes("notifyChatSessionRevokedForUser"), "unlink notifies after sv bump");
    assert(logoutClient.includes('requestChatSessionReset("logout")'), "device logout resets chat first");
    assert(login.includes('requestChatSessionReset("account_switch")'), "login switches off A sockets");
    assert(chat.includes("subscribeChatSessionReset"), "ChatClient listens for reset");
    assert(chat.includes("res.status === 401 || res.status === 403"), "revoked refresh returns null");
    assert(worker.includes("assertChatSessionCurrent"), "Worker re-checks current sv");
    assert(sessionCheck.includes("session_check_unconfigured"), "missing Next URL fail-closed");
    assert(sessionCheck.includes("session_check_unavailable"), "Next/DB down fail-closed");
    assert(!sessionCheck.includes("ok: true") || sessionCheck.includes("data.ok !== true"), "check is not fail-open");
  }

  section("session-check route + Worker helper fail-closed");
  {
    const { POST } = await import("../src/app/api/chat/session-check/route");
    const { prisma } = await import("../src/lib/prisma");
    const orig = prisma.user.findUnique.bind(prisma.user);
    prisma.user.findUnique = (async () => ({
      id: 9,
      role: "caddy",
      sessionVersion: 4,
      caddyId: 7,
      caddy: { employmentStatus: "ACTIVE" },
    })) as typeof prisma.user.findUnique;
    const ts = Math.floor(Date.now() / 1000);
    const auth = await signChatInternalAuth(
      process.env.CHAT_INTERNAL_SECRET || "",
      CHAT_SESSION_CHECK_PATH,
      ts
    );
    try {
      const current = await POST(
        new NextRequest("http://127.0.0.1/api/chat/session-check", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CHAT_INTERNAL_TS_HEADER]: String(ts),
            [CHAT_INTERNAL_AUTH_HEADER]: auth,
          },
          body: JSON.stringify({ userId: 9, sv: 4 }),
        })
      );
      const currentBody = await current.json();
      assert(current.status === 200 && currentBody.ok === true, "session-check allows current sv");

      const stale = await POST(
        new NextRequest("http://127.0.0.1/api/chat/session-check", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CHAT_INTERNAL_TS_HEADER]: String(ts),
            [CHAT_INTERNAL_AUTH_HEADER]: auth,
          },
          body: JSON.stringify({ userId: 9, sv: 3 }),
        })
      );
      const staleBody = await stale.json();
      assert(stale.status === 401 && staleBody.code === "stale_session", "session-check rejects stale sv");

      prisma.user.findUnique = (async () => ({
        id: 9,
        role: "caddy",
        sessionVersion: 4,
        caddyId: 7,
        caddy: { employmentStatus: "RETIRED" },
      })) as typeof prisma.user.findUnique;
      const retired = await POST(
        new NextRequest("http://127.0.0.1/api/chat/session-check", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CHAT_INTERNAL_TS_HEADER]: String(ts),
            [CHAT_INTERNAL_AUTH_HEADER]: auth,
          },
          body: JSON.stringify({ userId: 9, sv: 4 }),
        })
      );
      const retiredBody = await retired.json();
      assert(retired.status === 401 && retiredBody.code === "user_unavailable", "RETIRED rejected at check");

      const noAuth = await POST(
        new NextRequest("http://127.0.0.1/api/chat/session-check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: 9, sv: 4 }),
        })
      );
      assert(noAuth.status === 403, "session-check requires internal HMAC");
    } finally {
      prisma.user.findUnique = orig;
    }

    const { assertChatSessionCurrent } = await import(
      "../cloudflare/verthill-chat/src/sessionCheck"
    );
    const v2 = {
      v: 2 as const,
      userId: 9,
      displayName: "홍길동",
      role: "caddy" as const,
      team: "1조",
      sv: 1,
      iat: 1,
      exp: 9,
    };
    const missingUrl = await assertChatSessionCurrent(
      { CHAT_AUTH_SECRET: "x" },
      v2
    );
    assert(
      !missingUrl.ok && missingUrl.status === 503,
      "Worker without CHAT_PUSH_DISPATCH_URL fail-closed"
    );
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
    const v1ok = await assertChatSessionCurrent({ CHAT_AUTH_SECRET: "x" }, v1);
    assert(v1ok.ok, "v1 tokens keep prior policy (no session-check)");
  }

  section("notify helper posts revoke, does not mint tokens");
  {
    const prevWs = process.env.NEXT_PUBLIC_CHAT_WS_URL;
    const prevWorker = process.env.CHAT_WORKER_URL;
    let seen = "";
    const server = createServer((req, res) => {
      seen = `${req.method} ${req.url}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    delete process.env.NEXT_PUBLIC_CHAT_WS_URL;
    process.env.CHAT_WORKER_URL = `http://127.0.0.1:${port}`;
    try {
      const result = await notifyChatSessionRevoked({ userId: 9, sessionVersion: 8 });
      assert(result === "ok", "notify reaches Worker revoke path");
      assert(seen === `POST ${CHAT_SESSION_REVOKE_PATH}`, "notify uses /internal/session-revoke");
      const skipped = await notifyChatSessionRevoked({ userId: 0, sessionVersion: 1 });
      assert(skipped === "skipped", "invalid user is not notified");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevWs == null) delete process.env.NEXT_PUBLIC_CHAT_WS_URL;
      else process.env.NEXT_PUBLIC_CHAT_WS_URL = prevWs;
      if (prevWorker == null) delete process.env.CHAT_WORKER_URL;
      else process.env.CHAT_WORKER_URL = prevWorker;
    }
  }

  section("12. reconnect rules");
  {
    clearChatSessionEnded();
    assert(
      shouldAttemptChatReconnect({ generationMatches: true, hasToken: true }) === true,
      "network drop with live token may reconnect"
    );
    assert(shouldRefreshTokenOnClose(TOKEN_EXPIRED_CLOSE) === true, "4008 refreshes token");
    assert(shouldRefreshTokenOnClose(1006) === false, "network close reuses current token");
    markChatSessionEnded();
    assert(
      shouldAttemptChatReconnect({ generationMatches: true, hasToken: true }) === false,
      "logout/RETIRED sessionEnded stops reconnect loop"
    );
    clearChatSessionEnded();
    assert(
      shouldAttemptChatReconnect({ generationMatches: true, hasToken: false }) === false,
      "refresh failure (null token) stops reconnect"
    );
  }

  section("issue token still requires current sv");
  {
    const auth = {
      userId: 8,
      username: "lead",
      role: "leader",
      caddyId: 22,
      managedTeams: [],
      sessionVersion: 6,
      mustChangePassword: false,
      session: {} as ResolvedAuthUser["session"],
    } as ResolvedAuthUser;
    const issued = await issueChatAccessToken(
      {
        user: { async findUnique() { throw new Error("no env map"); } },
        caddy: {
          async findUnique() {
            return { id: 22, name: "조장", team: "1조", employmentStatus: "ACTIVE" };
          },
        },
      },
      auth,
      1_700_000_000
    );
    assert(issued.sessionVersion === 6, "minted token carries current sv");
    const verified = await verifyChatToken(issued.token, { nowSec: 1_700_000_010 });
    assert(verified?.v === 2 && verified.sv === 6, "minted HMAC includes sv");
    let code = "";
    try {
      await issueChatAccessToken(
        {
          user: { async findUnique() { throw new Error("no env map"); } },
          caddy: {
            async findUnique() {
              return { id: 22, name: "조장", team: "1조", employmentStatus: "ACTIVE" };
            },
          },
        },
        { ...auth, sessionVersion: Number.NaN } as ResolvedAuthUser,
        1_700_000_000
      );
    } catch (e) {
      code = e instanceof ChatAuthError ? e.code : "other";
    }
    assert(code === "chat_session_unversioned", "cannot mint without sv");
  }

  if (failed > 0) {
    console.error(`\nchat-session-lifecycle tests failed: ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nchat-session-lifecycle tests passed: ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
