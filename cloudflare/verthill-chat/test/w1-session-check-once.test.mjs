/**
 * W1: Worker /ws WebSocket 진입의 중복 Next/DB session-check 생략.
 * ChatRoom DO authorizeSocket 은 유지. Directory 는 Worker session-check 유지.
 * c679e51 확인서(DO 인증 생략) 금지. Local wrangler + mock only.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TEST_SECRET, signCreateGrant, signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJson(event) {
  return JSON.parse(String(event.data));
}

function waitMessage(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("timeout waiting for websocket message"));
    }, timeoutMs);
    function onMessage(event) {
      const data = parseJson(event);
      if (predicate(data)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(data);
      }
    }
    ws.addEventListener("message", onMessage);
  });
}

function waitClose(ws, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const done = (ev) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve(ev);
    };
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      resolve({ code: 4008, reason: "already-closing" });
      return;
    }
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    const poll = setInterval(() => {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        done({ code: 4008, reason: "closing" });
      }
    }, 50);
    ws.addEventListener("close", (ev) => done(ev));
  });
}

function connect(port, room, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
    );
    const timer = setTimeout(() => reject(new Error(`ws open timeout room=${room}`)), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`ws error room=${room}`));
    });
  });
}

function connectFail(port, room, token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
    );
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("expected websocket reject, timed out"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("expected websocket reject, but opened"));
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ kind: "error" });
    });
  });
}

function connectDirectory(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${HOST}:${port}/directory/ws?token=${encodeURIComponent(token)}`
    );
    const timer = setTimeout(() => reject(new Error("directory ws timeout")), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("directory ws error"));
    });
  });
}

async function wsStatus(port, room, token) {
  const res = await fetch(
    `http://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function dirStatus(port, token) {
  const res = await fetch(`http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function internalHeaders(path) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-chat-internal-ts": String(ts),
    "x-chat-internal-auth": createHmac("sha256", TEST_SECRET)
      .update(`${path}|${ts}`)
      .digest("base64url"),
  };
}

async function createDm(port, roomId, a, b) {
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(`http://${HOST}:${port}/directory/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant: signCreateGrant({
        v: 1,
        op: "create_room",
        roomId,
        name: "DM",
        ownerUserId: a.userId,
        members: [a, b],
        iat: now,
        exp: now + 60,
      }),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test("W1 source: DO still authorizeSocket; no c679e51 assertion", () => {
  const index = readFileSync(join(root, "../src/index.ts"), "utf8");
  assert.doesNotMatch(index, /wsAssertion|attachWsAssertion|readWsAssertion/);
  assert.match(
    index,
    /const authorized = await authorizeSocket\(request, this\.env\)/,
    "ChatRoom must keep full authorizeSocket"
  );
  assert.match(index, /shouldSkipWorkerSessionCheck/);
  assert.match(index, /sessionCheck !== "skip"/);
  assert.match(index, /\? "skip"/);
  assert.match(index, /c679e51/);
});

test("W1 wrangler: one session-check, auth/membership/revoke still hold", async () => {
  const { port, child, mock } = await startWrangler();
  try {
    const current = signTestTokenV2({ userId: 91, displayName: "현재", role: "caddy", sv: 2 });
    mock.setEpoch(91, 2);

    const sc0 = mock.checkCount();
    const httpOk = await wsStatus(port, "all", current.token);
    assert.equal(httpOk.status, 426, "HTTP /ws still upgrade_required after Worker session-check");
    assert.equal(mock.checkCount() - sc0, 1, "HTTP /ws probe still does 1 Worker session-check");

    const sc1 = mock.checkCount();
    const room = await connect(port, "all", current.token);
    await waitMessage(room, (d) => d.type === "history");
    assert.equal(mock.checkCount() - sc1, 1, "room WS entry does 1 session-check (DO), not 2");
    room.close();

    const sc2 = mock.checkCount();
    const dir = await connectDirectory(port, current.token);
    await waitMessage(dir, (d) => d.type === "rooms");
    assert.equal(mock.checkCount() - sc2, 1, "directory WS still 1 Worker session-check");
    dir.close();

    const stale = signTestTokenV2({ userId: 91, displayName: "과거", role: "caddy", sv: 1 });
    const staleHttp = await wsStatus(port, "all", stale.token);
    assert.equal(staleHttp.status, 401, "HTTP /ws stale still 401 at Worker");
    assert.equal(staleHttp.body.error, "stale_session");
    await connectFail(port, "all", stale.token);
    const staleDir = await dirStatus(port, stale.token);
    assert.equal(staleDir.status, 401, "directory stale still 401");
    assert.equal(staleDir.body.error, "stale_session");

    mock.setBlocked(92, true);
    const retired = signTestTokenV2({ userId: 92, displayName: "퇴사", role: "caddy", sv: 3 });
    const retiredHttp = await wsStatus(port, "all", retired.token);
    assert.equal(retiredHttp.status, 401, "HTTP blocked user 401");
    await connectFail(port, "all", retired.token);

    mock.setUnavailable(true);
    const downTok = signTestTokenV2({ userId: 93, displayName: "장애", role: "caddy", sv: 1 });
    const downHttp = await wsStatus(port, "all", downTok.token);
    assert.equal(downHttp.status, 503, "HTTP session-check down fail-closed");
    await connectFail(port, "all", downTok.token);
    const downDir = await dirStatus(port, downTok.token);
    assert.equal(downDir.status, 503, "directory session-check down fail-closed");
    mock.setUnavailable(false);

    const a = { userId: 94, displayName: "멤버A", role: "caddy", team: "1조" };
    const b = { userId: 95, displayName: "멤버B", role: "caddy", team: "2조" };
    const outsider = { userId: 96, displayName: "외부", role: "caddy", team: "3조" };
    const roomId = "dm_94_95";
    mock.setEpoch(94, 1);
    mock.setEpoch(95, 1);
    mock.setEpoch(96, 1);
    const created = await createDm(port, roomId, a, b);
    assert.equal(created.status, 200, "DM create");
    const aTok = signTestTokenV2({ ...a, sv: 1 });
    const outTok = signTestTokenV2({ ...outsider, sv: 1 });
    const memberHttp = await wsStatus(port, roomId, aTok.token);
    assert.equal(memberHttp.status, 426, "member HTTP upgrade_required");
    const outHttp = await wsStatus(port, roomId, outTok.token);
    assert.equal(outHttp.status, 403, "outsider HTTP room_forbidden");
    assert.equal(outHttp.body.error, "room_forbidden");
    await connectFail(port, roomId, outTok.token);
    const memberWs = await connect(port, roomId, aTok.token);
    await waitMessage(memberWs, (d) => d.type === "history");
    memberWs.close();

    const staleMember = signTestTokenV2({ ...a, sv: 0 });
    const staleMemberHttp = await wsStatus(port, roomId, staleMember.token);
    assert.equal(staleMemberHttp.status, 401, "stale member HTTP 401");
    await connectFail(port, roomId, staleMember.token);

    const live = signTestTokenV2({ userId: 97, displayName: "경합", role: "caddy", sv: 1 });
    mock.setEpoch(97, 1);
    mock.setDelayMs(180);
    const racing = connect(port, "all", live.token);
    await sleep(40);
    mock.setEpoch(97, 2);
    const revoke = await fetch(`http://${HOST}:${port}/internal/session-revoke`, {
      method: "POST",
      headers: internalHeaders("/internal/session-revoke"),
      body: JSON.stringify({ userId: 97, sessionVersion: 2 }),
    });
    assert.equal(revoke.status, 200, "revoke during handshake accepted");
    await assert.rejects(racing, /ws error/, "DO session-check sees bumped epoch; handshake fails");
    mock.setDelayMs(0);
    const afterRace = await wsStatus(port, "all", live.token);
    assert.equal(afterRace.status, 401, "old token cannot connect after race revoke");
    const fresh = signTestTokenV2({ userId: 97, displayName: "경합", role: "caddy", sv: 2 });
    mock.setEpoch(97, 2);
    const reopened = await connect(port, "all", fresh.token);
    await waitMessage(reopened, (d) => d.type === "history");
    reopened.close();

    const openTok = signTestTokenV2({ userId: 98, displayName: "열린소켓", role: "caddy", sv: 4 });
    mock.setEpoch(98, 4);
    const openWs = await connect(port, "all", openTok.token);
    await waitMessage(openWs, (d) => d.type === "history");
    const staleEvt = waitMessage(openWs, (d) => d.type === "error" && d.code === "stale_session");
    const closed = waitClose(openWs, 12000);
    const fanout = await fetch(`http://${HOST}:${port}/internal/session-revoke`, {
      method: "POST",
      headers: internalHeaders("/internal/session-revoke"),
      body: JSON.stringify({ userId: 98, sessionVersion: 5 }),
    });
    assert.equal(fanout.status, 200);
    assert.equal((await staleEvt).code, "stale_session");
    assert.equal((await closed).code, 4008);
    mock.setEpoch(98, 5);
    const oldReconnect = await wsStatus(port, "all", openTok.token);
    assert.equal(oldReconnect.status, 401, "revoked token cannot reconnect");
    await connectFail(port, "all", openTok.token);
    const newTok = signTestTokenV2({ userId: 98, displayName: "열린소켓", role: "caddy", sv: 5 });
    const again = await connect(port, "all", newTok.token);
    await waitMessage(again, (d) => d.type === "history");
    again.close();

    const tamper = signTestTokenV2({ userId: 99, displayName: "변조", role: "caddy", sv: 1 });
    mock.setEpoch(99, 1);
    const [body] = tamper.token.split(".");
    const bad = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const scBeforeTamper = mock.checkCount();
    const tamperedHttp = await wsStatus(port, "all", bad);
    assert.equal(tamperedHttp.status, 401);
    assert.equal(tamperedHttp.body.error, "invalid_token");
    await connectFail(port, "all", bad);
    assert.equal(mock.checkCount(), scBeforeTamper, "tampered token never reaches session-check");
  } finally {
    await stopWrangler(child);
  }
});
