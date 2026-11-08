/**
 * Parked WS {type:"resume"}: fail-closed session-check + membership, then history.
 * Local wrangler + mock session-check only. No Production Worker/DB.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

function collectFrames(ws) {
  const frames = [];
  const onMessage = (event) => {
    frames.push({ t: performance.now(), data: parseJson(event) });
  };
  ws.addEventListener("message", onMessage);
  return {
    frames,
    stop() {
      ws.removeEventListener("message", onMessage);
    },
  };
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

function findDirectorySqlite(persistTo) {
  for (const file of walkFiles(persistTo)) {
    if (!file.endsWith(".sqlite")) continue;
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row.name));
      db.close();
      if (tables.includes("rooms") && tables.includes("members")) return file;
    } catch {
      // not a Directory sqlite
    }
  }
  return null;
}

function dropDmMember(persistTo, roomId, userId) {
  const file = findDirectorySqlite(persistTo);
  assert.ok(file, "Directory sqlite exists after first create");
  const db = new DatabaseSync(file);
  db.prepare("DELETE FROM members WHERE room_id = ? AND user_id = ?").run(roomId, userId);
  const left = db
    .prepare("SELECT user_id FROM members WHERE room_id = ?")
    .all(roomId)
    .map((row) => Number(row.user_id));
  db.close();
  return left;
}

test("source: resume awaits session-check then history; no probe", () => {
  const index = readFileSync(join(root, "../src/index.ts"), "utf8");
  assert.match(index, /private async handleParkedResume/);
  assert.match(index, /await assertChatSessionCurrent\(this\.env, attach\.claims\)/);
  assert.doesNotMatch(
    index.slice(index.indexOf("private async handleParkedResume"), index.indexOf("private expireUnavailable")),
    /probeChatSession/
  );
  assert.match(index, /this\.resumeInflight\.add\(ws\)/);
  assert.match(index, /async webSocketMessage/);
  assert.match(index, /await run/);
  assert.match(index, /parkedResumeVerdict/);
  const fn = index.slice(
    index.indexOf("private async handleParkedResume"),
    index.indexOf("private expireUnavailable")
  );
  assert.ok(fn.indexOf("assertChatSessionCurrent") < fn.indexOf("sendAuthorized"));
  assert.ok(fn.indexOf("sendAuthorized") < fn.indexOf("sendHistory"));
  assert.ok(fn.indexOf('verdict.action === "deny"') < fn.indexOf("sendAuthorized"));
});

test("wrangler: resume rechecks session then history; revoke/block/unavailable/membership drop socket", async () => {
  const persistTo = mkdtempSync(join(tmpdir(), "parked-resume-"));
  const uid = 300000 + (Date.now() % 100000);
  const { port, child, mock } = await startWrangler({ persistTo });
  try {
    const tok = signTestTokenV2({ userId: uid, displayName: "재개", role: "caddy", sv: 2 });
    mock.setEpoch(uid, 2);
    const ws = await connect(port, "all", tok.token);
    await waitMessage(ws, (d) => d.type === "history");

    mock.setDelayMs(180);
    const scResume0 = mock.checkCount();
    const tResume = performance.now();
    ws.send(JSON.stringify({ type: "resume" }));
    const hist = await waitMessage(ws, (d) => d.type === "history");
    const resumeMs = performance.now() - tResume;
    assert.equal(hist.type, "history", "resume sends history after auth");
    assert.equal(mock.checkCount() - scResume0, 1, "resume does 1 session-check");
    assert.ok(resumeMs >= 160, `resume waits for session-check (${Math.round(resumeMs)}ms)`);

    const scHist0 = mock.checkCount();
    ws.send(JSON.stringify({ type: "history", beforeSeq: 9007199254740991, limit: 30 }));
    await waitMessage(ws, (d) => d.type === "history");
    assert.equal(mock.checkCount() - scHist0, 0, "in-room history pagination does not session-check");

    const scHttp0 = mock.checkCount();
    const http = await fetch(
      `http://${HOST}:${port}/directory/rooms/all?token=${encodeURIComponent(tok.token)}`
    );
    assert.equal(http.status, 200, "Directory GET still session-checks");
    assert.equal(mock.checkCount() - scHttp0, 1, "HTTP GET = 1 session-check");
    mock.setDelayMs(0);

    const collector = collectFrames(ws);
    mock.setDelayMs(200);
    const tRace = performance.now();
    ws.send(JSON.stringify({ type: "resume" }));
    ws.send(JSON.stringify({ type: "history", beforeSeq: 9007199254740991, limit: 30 }));
    await sleep(60);
    const early = collector.frames.filter(
      (f) => f.data.type === "history" && f.t - tRace < 120
    );
    assert.equal(early.length, 0, "interleaved history does not leak before session-check");
    await waitMessage(ws, (d) => d.type === "history");
    collector.stop();
    mock.setDelayMs(0);

    mock.setEpoch(uid, 3);
    const staleEvt = waitMessage(ws, (d) => d.type === "error");
    const closed = waitClose(ws, 12000);
    const fanout = await fetch(`http://${HOST}:${port}/internal/session-revoke`, {
      method: "POST",
      headers: internalHeaders("/internal/session-revoke"),
      body: JSON.stringify({ userId: uid, sessionVersion: 3 }),
    });
    assert.equal(fanout.status, 200);
    const err = await staleEvt;
    assert.equal(err.code, "stale_session");
    assert.equal((await closed).code, 4008);
    mock.setEpoch(uid, 3);

    const tok2 = signTestTokenV2({ userId: uid + 1, displayName: "차단재개", role: "caddy", sv: 1 });
    mock.setEpoch(uid + 1, 1);
    const ws2 = await connect(port, "all", tok2.token);
    await waitMessage(ws2, (d) => d.type === "history");
    mock.setBlocked(uid + 1, true);
    const frames2 = collectFrames(ws2);
    const err2 = waitMessage(ws2, (d) => d.type === "error");
    const close2 = waitClose(ws2, 12000);
    ws2.send(JSON.stringify({ type: "resume" }));
    assert.equal((await err2).code, "stale_session", "blocked user resume is stale_session");
    assert.equal((await close2).code, 4008);
    assert.equal(
      frames2.frames.filter((f) => f.data.type === "history").length,
      0,
      "blocked resume sends no history"
    );
    assert.equal(
      frames2.frames.filter((f) => f.data.type === "authorized").length,
      0,
      "blocked resume sends no authorized"
    );
    frames2.stop();

    const tok3 = signTestTokenV2({ userId: uid + 2, displayName: "장애재개", role: "caddy", sv: 1 });
    mock.setEpoch(uid + 2, 1);
    const ws3 = await connect(port, "all", tok3.token);
    await waitMessage(ws3, (d) => d.type === "history");
    mock.setUnavailable(true);
    const frames3 = collectFrames(ws3);
    const err3 = waitMessage(ws3, (d) => d.type === "error");
    const close3 = waitClose(ws3, 12000);
    ws3.send(JSON.stringify({ type: "resume" }));
    assert.equal((await err3).code, "session_check_unavailable", "unavailable fail-closed");
    assert.equal((await close3).code, 1011);
    assert.equal(
      frames3.frames.filter((f) => f.data.type === "history").length,
      0,
      "unavailable resume sends no history"
    );
    assert.equal(
      frames3.frames.filter((f) => f.data.type === "authorized").length,
      0,
      "unavailable resume sends no authorized"
    );
    frames3.stop();
    mock.setUnavailable(false);

    const a = { userId: uid + 3, displayName: "멤버A", role: "caddy", team: "1조" };
    const b = { userId: uid + 4, displayName: "멤버B", role: "caddy", team: "2조" };
    const lo = Math.min(a.userId, b.userId);
    const hi = Math.max(a.userId, b.userId);
    const roomId = `dm_${lo}_${hi}`;
    mock.setEpoch(a.userId, 1);
    mock.setEpoch(b.userId, 1);
    const created = await createDm(port, roomId, a, b);
    assert.equal(created.status, 200, "DM create");
    const aTok = signTestTokenV2({ ...a, sv: 1 });
    const memberWs = await connect(port, roomId, aTok.token);
    await waitMessage(memberWs, (d) => d.type === "history");
    const scDm = mock.checkCount();
    memberWs.send(JSON.stringify({ type: "resume" }));
    const dmHist = await waitMessage(memberWs, (d) => d.type === "history");
    assert.equal(dmHist.type, "history", "DM member resume still sends history");
    assert.equal(mock.checkCount() - scDm, 1, "DM resume session-check 1");

    const framesMem = collectFrames(memberWs);
    const errMem = waitMessage(memberWs, (d) => d.type === "error");
    const closeMem = waitClose(memberWs, 12000);
    const left = dropDmMember(persistTo, roomId, a.userId);
    assert.equal(left.includes(a.userId), false, "A removed from Directory members");
    memberWs.send(JSON.stringify({ type: "resume" }));
    assert.equal((await errMem).code, "room_forbidden", "membership removal denies resume");
    assert.equal((await closeMem).code, 4003);
    assert.equal(
      framesMem.frames.filter((f) => f.data.type === "history").length,
      0,
      "membership-removed resume sends no history"
    );
    assert.equal(
      framesMem.frames.filter((f) => f.data.type === "authorized").length,
      0,
      "membership-removed resume sends no authorized"
    );
    framesMem.stop();

    const tok4 = signTestTokenV2({ userId: uid + 5, displayName: "경합재개", role: "caddy", sv: 1 });
    mock.setEpoch(uid + 5, 1);
    const ws4 = await connect(port, "all", tok4.token);
    await waitMessage(ws4, (d) => d.type === "history");
    mock.setDelayMs(180);
    const frames4 = collectFrames(ws4);
    const err4 = waitMessage(ws4, (d) => d.type === "error");
    const close4 = waitClose(ws4, 12000);
    ws4.send(JSON.stringify({ type: "resume" }));
    await sleep(40);
    mock.setEpoch(uid + 5, 2);
    const raceRevoke = await fetch(`http://${HOST}:${port}/internal/session-revoke`, {
      method: "POST",
      headers: internalHeaders("/internal/session-revoke"),
      body: JSON.stringify({ userId: uid + 5, sessionVersion: 2 }),
    });
    assert.equal(raceRevoke.status, 200);
    const raceErr = await err4;
    assert.ok(
      raceErr.code === "stale_session" || raceErr.code === "session_check_unavailable",
      `race revoke closes without history (${raceErr.code})`
    );
    await close4;
    assert.equal(
      frames4.frames.filter((f) => f.data.type === "history").length,
      0,
      "revoke during resume sends no history"
    );
    assert.equal(
      frames4.frames.filter((f) => f.data.type === "authorized").length,
      0,
      "revoke during resume sends no authorized"
    );
    frames4.stop();
    mock.setDelayMs(0);
  } finally {
    await stopWrangler(child);
    try {
      rmSync(persistTo, { recursive: true, force: true });
    } catch {
      // temp state
    }
  }
});
