/**
 * 세션 폐기 안정성 — 로컬 wrangler + mock Next session-check 만. Production Worker/DB/퇴사 API 없음.
 * 시나리오: 1 정상 퇴사·종료, 5 중복 revoke, 6 기존 WS 종료, 7 구 토큰 재연결 차단,
 * 8 다른 캐디 연결 유지, 작업3 알림 실패 시 열린 소켓 주기 재검증(+ Next 장애 시 유지).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { TEST_SECRET, signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitMessage(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("timeout waiting for websocket message"));
    }, timeoutMs);
    function onMessage(event) {
      const data = JSON.parse(String(event.data));
      if (predicate(data)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(data);
      }
    }
    ws.addEventListener("message", onMessage);
  });
}

// 로컬 wrangler 는 서버측 close 후 close 이벤트가 늦을 수 있어 기존 lifecycle 테스트처럼 CLOSING 도 종료로 본다.
function waitClose(ws, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return resolve({ code: 4008, reason: "already-closing" });
    }
    const done = (ev) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve(ev);
    };
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("close timeout"));
    }, timeoutMs);
    const poll = setInterval(() => {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        done({ code: 4008, reason: "closing" });
      }
    }, 50);
    ws.addEventListener("close", (ev) => done(ev));
  });
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    });
  });
}

async function connectRoom(port, token) {
  const ws = await open(`ws://${HOST}:${port}/ws?room=all&token=${encodeURIComponent(token)}`);
  await waitMessage(ws, (d) => d.type === "history");
  return ws;
}

async function connectDir(port, token) {
  const ws = await open(`ws://${HOST}:${port}/directory/ws?token=${encodeURIComponent(token)}`);
  await waitMessage(ws, (d) => d.type === "rooms");
  return ws;
}

function internalHeaders(path) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-chat-internal-ts": String(ts),
    "x-chat-internal-auth": createHmac("sha256", TEST_SECRET).update(`${path}|${ts}`).digest("base64url"),
  };
}

async function revoke(port, userId, sessionVersion) {
  const res = await fetch(`http://${HOST}:${port}/internal/session-revoke`, {
    method: "POST",
    headers: internalHeaders("/internal/session-revoke"),
    body: JSON.stringify({ userId, sessionVersion }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function wsStatus(port, token) {
  const res = await fetch(`http://${HOST}:${port}/ws?room=all&token=${encodeURIComponent(token)}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function sendAndEcho(sender, body) {
  const id = `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const got = waitMessage(sender, (d) => d.type === "message" && d.clientMessageId === id);
  sender.send(JSON.stringify({ type: "message", clientMessageId: id, body }));
  return got;
}

const isOpen = (ws) => ws.readyState === WebSocket.OPEN;

test("revoke semantics: ok body, socket close, duplicates, old-token reconnect, peers kept", async () => {
  const { port, child, mock } = await startWrangler();
  try {
    // 대상(31) + 다른 캐디(33)
    const target = signTestTokenV2({ userId: 31, displayName: "퇴사대상", role: "caddy", sv: 1 });
    const peer = signTestTokenV2({ userId: 33, displayName: "동료", role: "caddy", sv: 4 });
    mock.setEpoch(31, 1);
    mock.setEpoch(33, 4);
    const tRoom = await connectRoom(port, target.token);
    const tDir = await connectDir(port, target.token);
    const pRoom = await connectRoom(port, peer.token);
    const pDir = await connectDir(port, peer.token);

    const tRoomStale = waitMessage(tRoom, (d) => d.type === "error" && d.code === "stale_session");
    const tDirStale = waitMessage(tDir, (d) => d.type === "error" && d.code === "stale_session");
    const tRoomClose = waitClose(tRoom);
    const tDirClose = waitClose(tDir);

    // 1. 정상 퇴사(sv 1→2) 알림
    mock.setEpoch(31, 2);
    const t0 = Date.now();
    const r1 = await revoke(port, 31, 2);
    const el = Date.now() - t0;
    assert.equal(r1.status, 200, "1. revoke 200 only when all rooms confirmed");
    assert.equal(r1.body.status, "ok");
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.epochStored, true, "1. directory epoch stored");
    assert.equal(r1.body.directoryClosed, 1, "1/6. directory socket closed by revoke");
    assert.ok(r1.body.rooms.total >= 13, `1. rooms = all + team rooms (+ member rooms): ${r1.body.rooms.total}`);
    assert.equal(r1.body.rooms.ok, r1.body.rooms.total, "1. every target room confirmed");
    assert.equal(r1.body.rooms.failed + r1.body.rooms.timeout + r1.body.rooms.skipped, 0);
    assert.ok(["ok"].includes(r1.body.allRoom), "1. direct all-room poke ok");
    assert.ok(el < 2500, `1. Worker answered inside Next attempt timeout (${el}ms)`);
    const bodyText = JSON.stringify(r1.body);
    assert.ok(!/퇴사대상|token|secret/.test(bodyText), "1. response has no PII/token");

    // 6. 기존 WS 종료
    assert.equal((await tRoomStale).code, "stale_session", "6. open room socket told stale_session");
    assert.equal((await tDirStale).code, "stale_session", "6. open directory socket told stale_session");
    assert.equal((await tRoomClose).code, 4008, "6. room socket closed 4008");
    assert.equal((await tDirClose).code, 4008, "6. directory socket closed 4008");

    // 7. 구버전 토큰 재연결 차단
    const re = await wsStatus(port, target.token);
    assert.equal(re.status, 401, "7. old token reconnect rejected");
    assert.equal(re.body.error, "stale_session");

    // 8. 다른 캐디 연결 유지 + 송수신
    assert.ok(isOpen(pRoom) && isOpen(pDir), "8. peer sockets still open");
    const echo = await sendAndEcho(pRoom, "peer-still-alive");
    assert.equal(echo.body, "peer-still-alive", "8. peer can still send/receive");
    const dirUpdate = waitMessage(pDir, (d) => d.type === "rooms");
    await sendAndEcho(pRoom, "peer-dir-update");
    await dirUpdate;
    assert.ok(isOpen(pDir), "8. peer directory still receives updates");

    // 핫패스: 기본 주기(5분) 안에서는 메시지 송수신이 session-check 를 부르지 않는다.
    const checksBefore = mock.checkCount();
    for (let i = 0; i < 5; i++) await sendAndEcho(pRoom, `hot-path-${i}`);
    await sleep(200);
    assert.equal(mock.checkCount(), checksBefore, "hot path: no session-check per message within interval");

    // 5. 동일 revoke 중복 요청(동시 3건 + 늦게 도착한 낮은 sv)
    const dup = await Promise.all([revoke(port, 31, 2), revoke(port, 31, 2), revoke(port, 31, 2)]);
    assert.ok(dup.every((d) => d.status === 200 && d.body.status === "ok"), "5. concurrent duplicate revokes all ok (idempotent)");
    // 재입사 등으로 새 토큰(sv=2) 연결 후, 늦은 중복/구 revoke 가 새 세션을 끊지 않아야 함
    const fresh = signTestTokenV2({ userId: 31, displayName: "재접속", role: "caddy", sv: 2 });
    const fRoom = await connectRoom(port, fresh.token);
    const late = await revoke(port, 31, 2);
    const older = await revoke(port, 31, 1);
    assert.equal(late.status, 200);
    assert.equal(older.status, 200, "5. older sv revoke accepted (max kept, no rollback)");
    await sleep(300);
    assert.ok(isOpen(fRoom), "5. duplicate/older revoke does not close a current-sv socket");
    const freshEcho = await sendAndEcho(fRoom, "fresh-session-ok");
    assert.equal(freshEcho.body, "fresh-session-ok", "5. current-sv socket still works");
    fRoom.close();

    // 잘못된 요청은 그대로 4xx (성공/실패 집계와 구분)
    const bad = await fetch(`http://${HOST}:${port}/internal/session-revoke`, {
      method: "POST",
      headers: internalHeaders("/internal/session-revoke"),
      body: JSON.stringify({ userId: -1, sessionVersion: 1 }),
    });
    assert.equal(bad.status, 400, "invalid payload stays 400");
    pRoom.close();
    pDir.close();
  } finally {
    await stopWrangler(child);
  }
});

test("task3: notify lost → open sockets re-checked periodically; Next outage keeps sockets", async () => {
  const { port, child, mock } = await startWrangler({
    extraArgs: ["--var", "CHAT_OPEN_SOCKET_RECHECK_MS:1000"],
  });
  try {
    const victim = signTestTokenV2({ userId: 41, displayName: "알림유실", role: "caddy", sv: 1 });
    const keep = signTestTokenV2({ userId: 42, displayName: "정상", role: "caddy", sv: 1 });
    const peer = signTestTokenV2({ userId: 43, displayName: "동료", role: "caddy", sv: 1 });
    mock.setEpoch(41, 1);
    mock.setEpoch(42, 1);
    mock.setEpoch(43, 1);
    const vRoom = await connectRoom(port, victim.token);
    const vDir = await connectDir(port, victim.token);
    const kRoom = await connectRoom(port, keep.token);
    const pRoom = await connectRoom(port, peer.token);

    // (a) Next 장애: 재검증이 unknown → 아무도 닫히지 않음(정상 사용자 안정성)
    mock.setUnavailable(true);
    await sleep(1200);
    const outageChecks0 = mock.checkCount();
    await sendAndEcho(pRoom, "during-next-outage");
    await sleep(500);
    assert.ok(mock.checkCount() > outageChecks0, "re-check was attempted during outage");
    assert.ok(isOpen(vRoom) && isOpen(vDir) && isOpen(kRoom) && isOpen(pRoom), "Next outage: open sockets kept (fail-open for existing)");
    mock.setUnavailable(false);

    // (b) 퇴사(sv 증가)됐지만 Worker 알림은 유실(revoke 호출 안 함)
    mock.setEpoch(41, 2);
    const vRoomStale = waitMessage(vRoom, (d) => d.type === "error" && d.code === "stale_session", 10000);
    const vDirStale = waitMessage(vDir, (d) => d.type === "error" && d.code === "stale_session", 10000);
    const vRoomClose = waitClose(vRoom, 10000);
    const vDirClose = waitClose(vDir, 10000);
    await sleep(1200); // retry backoff(=interval 1s) 경과
    const checks0 = mock.checkCount();
    // 활동이 재검증을 트리거(핫패스는 숫자 비교만, 확인은 비동기)
    await sendAndEcho(pRoom, "trigger-recheck-1");
    await sleep(400);
    await sendAndEcho(pRoom, "trigger-recheck-2");
    assert.equal((await vRoomStale).code, "stale_session", "task3: room socket closed after periodic re-check");
    assert.equal((await vDirStale).code, "stale_session", "task3: directory socket closed after periodic re-check");
    assert.equal((await vRoomClose).code, 4008);
    assert.equal((await vDirClose).code, 4008);
    const used = mock.checkCount() - checks0;
    // 사용자·DO 별 주기당 최대 1회: 4 사용자 소켓(41 room/dir, 42, 43) × 최대 2 트리거 → 상한 여유 있게
    assert.ok(used >= 2 && used <= 10, `re-check calls bounded (${used})`);

    // 8. 다른 사용자 유지
    await sleep(300);
    assert.ok(isOpen(kRoom) && isOpen(pRoom), "8. current users unaffected by re-check");
    const e = await sendAndEcho(kRoom, "keep-alive");
    assert.equal(e.body, "keep-alive");
    kRoom.close();
    pRoom.close();
  } finally {
    await stopWrangler(child);
  }
});
