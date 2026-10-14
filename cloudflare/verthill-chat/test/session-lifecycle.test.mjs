/**
 * Chat token/session lifecycle against local wrangler + mock Next session-check.
 * No Production Worker/DB.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { TEST_SECRET, signTestToken, signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

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

async function wsStatus(port, room, token) {
  const res = await fetch(
    `http://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function dirStatus(port, token) {
  const res = await fetch(
    `http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(token)}`
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test("session lifecycle: sv check, revoke, expiry, reconnect", async () => {
  const { port, child, mock } = await startWrangler();
  try {
    const current = signTestTokenV2({ userId: 21, displayName: "현재", role: "caddy", sv: 2 });
    mock.setEpoch(21, 2);
    const allowed = await wsStatus(port, "all", current.token);
    assert.equal(allowed.status, 426, "2. current sv may upgrade");
    const dirAllowed = await dirStatus(port, current.token);
    assert.equal(dirAllowed.status, 200, "2. current sv directory HTTP allowed");

    const stale = signTestTokenV2({ userId: 21, displayName: "과거", role: "caddy", sv: 1 });
    const staleWs = await wsStatus(port, "all", stale.token);
    assert.equal(staleWs.status, 401, "3. stale sv new room connection rejected");
    assert.equal(staleWs.body.error, "stale_session");
    const staleDir = await dirStatus(port, stale.token);
    assert.equal(staleDir.status, 401, "3. stale sv new directory connection rejected");

    const live = signTestTokenV2({ userId: 22, displayName: "철회대상", role: "caddy", sv: 1 });
    mock.setEpoch(22, 1);
    const room = await connect(port, "all", live.token);
    await waitMessage(room, (d) => d.type === "history");
    const dir = await connectDirectory(port, live.token);
    await waitMessage(dir, (d) => d.type === "rooms");

    const roomStale = waitMessage(
      room,
      (d) => d.type === "error" && d.code === "stale_session"
    );
    const dirStale = waitMessage(
      dir,
      (d) => d.type === "error" && d.code === "stale_session"
    );
    const roomCloseP = waitClose(room, 12000);
    const dirCloseP = waitClose(dir, 12000);
    const revoke = await fetch(`http://${HOST}:${port}/internal/session-revoke`, {
      method: "POST",
      headers: internalHeaders("/internal/session-revoke"),
      body: JSON.stringify({ userId: 22, sessionVersion: 2 }),
    });
    assert.equal(revoke.status, 200, "7. Worker accepts internal revoke");
    assert.equal((await roomStale).code, "stale_session", "7. open room socket gets stale_session");
    assert.equal((await dirStale).code, "stale_session", "7. open directory socket gets stale_session");
    const roomClose = await roomCloseP;
    const dirClose = await dirCloseP;
    assert.equal(roomClose.code, 4008, "7. open room socket closed after logout-all fanout");
    assert.equal(dirClose.code, 4008, "7. open directory socket closed after logout-all fanout");
    assert.ok(
      room.readyState === WebSocket.CLOSING || room.readyState === WebSocket.CLOSED,
      "7. room socket is no longer writable"
    );
    assert.ok(
      dir.readyState === WebSocket.CLOSING || dir.readyState === WebSocket.CLOSED,
      "7. directory socket is no longer writable"
    );

    mock.setEpoch(22, 2);
    const afterRevoke = await wsStatus(port, "all", live.token);
    assert.equal(afterRevoke.status, 401, "7/8/9. old token cannot reconnect after sv bump");
    assert.equal(afterRevoke.body.error, "stale_session");
    const afterRevokeDir = await dirStatus(port, live.token);
    assert.equal(afterRevokeDir.status, 401, "7/8/9. old token directory HTTP rejected");

    mock.setBlocked(23, true);
    const retired = signTestTokenV2({ userId: 23, displayName: "퇴직", role: "caddy", sv: 5 });
    const retiredWs = await wsStatus(port, "all", retired.token);
    assert.equal(retiredWs.status, 401, "9. RETIRED session-check rejects new connection");

    const now = Math.floor(Date.now() / 1000);
    const expiring = signTestTokenV2({
      userId: 24,
      displayName: "만료",
      role: "caddy",
      sv: 1,
      iat: now - 10,
      exp: now + 2,
    });
    const peer = signTestTokenV2({ userId: 25, displayName: "상대", role: "caddy", sv: 1 });
    mock.setEpoch(24, 1);
    mock.setEpoch(25, 1);
    const expRoom = await connect(port, "all", expiring.token);
    await waitMessage(expRoom, (d) => d.type === "history");
    const expDir = await connectDirectory(port, expiring.token);
    await waitMessage(expDir, (d) => d.type === "rooms");
    const peerRoom = await connect(port, "all", peer.token);
    await waitMessage(peerRoom, (d) => d.type === "history");
    const peerDir = await connectDirectory(port, peer.token);
    await waitMessage(peerDir, (d) => d.type === "rooms");

    await new Promise((r) => setTimeout(r, 2500));
    const expiredConnect = await wsStatus(port, "all", expiring.token);
    assert.equal(expiredConnect.status, 401, "10. expired token cannot open a new room socket");

    let expiredRoomSawMessage = false;
    let expiredDirSawRooms = false;
    expRoom.addEventListener("message", (event) => {
      const data = parseJson(event);
      if (data.type === "message") expiredRoomSawMessage = true;
    });
    expDir.addEventListener("message", (event) => {
      const data = parseJson(event);
      if (data.type === "rooms") expiredDirSawRooms = true;
    });
    const expRoomMsg = waitMessage(expRoom, (d) => d.type === "error" && d.code === "expired_token");
    const expDirMsg = waitMessage(expDir, (d) => d.type === "error" && d.code === "expired_token");
    const expRoomClose = waitClose(expRoom);
    const expDirClose = waitClose(expDir);
    const outboundId = `alive-${Date.now()}`;
    const peerGot = waitMessage(
      peerRoom,
      (d) => d.type === "message" && d.clientMessageId === outboundId
    );
    peerRoom.send(
      JSON.stringify({ type: "message", clientMessageId: outboundId, body: "still-alive" })
    );
    await peerGot;
    assert.equal((await expRoomMsg).code, "expired_token", "10. outbound to expired room is blocked");
    assert.equal((await expRoomClose).code, 4008, "10. expired room socket closes 4008");
    assert.equal(expiredRoomSawMessage, false, "10. expired room does not receive new messages");

    expDir.send(JSON.stringify({ type: "sync" }));
    assert.equal((await expDirMsg).code, "expired_token", "11. inbound/outbound directory on expired socket blocked");
    assert.equal((await expDirClose).code, 4008, "11. expired directory socket closes 4008");
    assert.equal(expiredDirSawRooms, false, "11. expired directory does not receive room updates");

    const reconnectTok = signTestTokenV2({ userId: 26, displayName: "재접속", role: "caddy", sv: 1 });
    mock.setEpoch(26, 1);
    const first = await connect(port, "all", reconnectTok.token);
    await waitMessage(first, (d) => d.type === "history");
    first.close();
    await waitClose(first);
    const second = await connect(port, "all", reconnectTok.token);
    const hist = await waitMessage(second, (d) => d.type === "history");
    assert.equal(hist.type, "history", "12. valid token reconnects after a clean close");
    second.close();

    mock.setUnavailable(true);
    const failClosed = signTestTokenV2({ userId: 27, displayName: "차단", role: "caddy", sv: 1 });
    const down = await wsStatus(port, "all", failClosed.token);
    assert.equal(down.status, 503, "session-check unavailable fail-closed");
    const v1 = signTestToken({ userId: 28, displayName: "레거시", room: "team-1", team: "1조" });
    const v1ok = await wsStatus(port, "team-1", v1.token);
    assert.equal(v1ok.status, 426, "v1 keeps prior policy while check is down");
    mock.setUnavailable(false);

    const browserRevoke = await fetch(`http://${HOST}:${port}/internal/session-revoke`, {
      method: "POST",
      headers: {
        ...internalHeaders("/internal/session-revoke"),
        origin: "https://evil.example",
      },
      body: JSON.stringify({ userId: 22, sessionVersion: 3 }),
    });
    assert.equal(browserRevoke.status, 403, "browser Origin cannot call session-revoke");
  } finally {
    await stopWrangler(child);
  }
});
