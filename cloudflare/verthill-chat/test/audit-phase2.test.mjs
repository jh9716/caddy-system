import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TEST_SECRET, signCreateGrant, signTestToken, signTestTokenV2 } from "./token-helper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function parseJson(event) {
  return JSON.parse(String(event.data));
}

function waitMessage(ws, predicate, timeoutMs = 12000) {
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
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: ws.code ?? 0 });
      return;
    }
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve(ev);
    });
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

async function startWrangler() {
  const port = await freePort();
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(port),
      "--ip",
      HOST,
      "--var",
      `CHAT_AUTH_SECRET:${TEST_SECRET}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`wrangler ready timeout\n${output}`));
    }, 45000);
    const onData = (buf) => {
      output += buf.toString();
      if (
        (output.includes("Ready") || output.includes("ready") || /http:\/\/127\.0\.0\.1:\d+/.test(output)) &&
        (output.includes("Ready on") || output.includes(`http://${HOST}:${port}`) || output.includes("Starting local server"))
      ) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrangler exited ${code}\n${output}`));
    });
  });
  await ready;
  await new Promise((r) => setTimeout(r, 300));
  return { port, child };
}

async function stopWrangler(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 2000))]);
}

function createGrant(roomId, ownerUserId, members) {
  const now = Math.floor(Date.now() / 1000);
  return signCreateGrant({
    v: 1,
    op: "create_room",
    roomId,
    name: "감사방",
    ownerUserId,
    members,
    iat: now,
    exp: now + 60,
  });
}

test("phase2 audit: history persist, security, expiry, unread, idempotency", async () => {
  const { port, child } = await startWrangler();
  try {
    const aTok = signTestTokenV2({ userId: 1, displayName: "A", role: "caddy" });
    const bTok = signTestTokenV2({ userId: 2, displayName: "B", role: "caddy" });
    const outsider = signTestTokenV2({ userId: 3, displayName: "C", role: "caddy" });

    const identityCreate = await fetch(`http://${HOST}:${port}/directory/rooms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aTok.token}`,
      },
      body: JSON.stringify({
        name: "spoof",
        members: [{ userId: 99, displayName: "ghost", role: "admin", team: "-" }],
      }),
    });
    assert.equal(identityCreate.status, 401);

    const now = Math.floor(Date.now() / 1000);
    const roomId = "room_aaaaaaaaaaaaaaaa";
    const grant = createGrant(roomId, 1, [
      { userId: 1, displayName: "A", role: "caddy", team: "1조" },
      { userId: 2, displayName: "B", role: "caddy", team: "2조" },
    ]);
    const originCreate = await fetch(`http://${HOST}:${port}/directory/rooms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ grant }),
    });
    assert.equal(originCreate.status, 403);
    const originBody = await originCreate.json();
    assert.equal(originBody.error, "server_only");

    const spoofMeta = await fetch(`http://${HOST}:${port}/internal/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId,
        seq: 999,
        preview: "fake",
        senderUserId: 1,
        senderName: "A",
        senderRole: "admin",
        sentAt: new Date().toISOString(),
      }),
    });
    assert.equal(spoofMeta.status, 404);

    const created = await fetch(`http://${HOST}:${port}/directory/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant }),
    });
    assert.equal(created.status, 200);
    const createdAgain = await fetch(`http://${HOST}:${port}/directory/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant }),
    });
    assert.equal(createdAgain.status, 200);
    const againBody = await createdAgain.json();
    assert.equal(againBody.roomId, roomId);
    assert.equal(againBody.idempotent, true);

    const a = await connect(port, roomId, aTok.token);
    await waitMessage(a, (d) => d.type === "history");
    const lastId = `hist-100-${now}`;
    const lastWait = waitMessage(a, (d) => d.type === "message" && d.clientMessageId === lastId, 20000);
    for (let i = 1; i <= 100; i++) {
      a.send(
        JSON.stringify({
          type: "message",
          clientMessageId: i === 100 ? lastId : `hist-${i}-${now}`,
          body: `m${i}`,
        })
      );
    }
    await lastWait;
    a.close();

    const a2 = await connect(port, roomId, aTok.token);
    const firstPage = await waitMessage(a2, (d) => d.type === "history");
    assert.equal(firstPage.messages.length, 30);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.messages[firstPage.messages.length - 1].body, "m100");
    const firstIds = firstPage.messages.map((m) => m.clientMessageId);
    assert.equal(new Set(firstIds).size, firstIds.length);
    const oldest = firstPage.oldestSeq;
    assert.ok(Number.isInteger(oldest));

    const olderWait = waitMessage(a2, (d) => d.type === "history" && d.oldestSeq !== oldest);
    a2.send(JSON.stringify({ type: "history", beforeSeq: oldest, limit: 30 }));
    const secondPage = await olderWait;
    assert.equal(secondPage.messages.length, 30);
    assert.equal(secondPage.hasMore, true);
    const overlap = secondPage.messages.some((m) => firstIds.includes(m.clientMessageId));
    assert.equal(overlap, false);
    const seqs = [...secondPage.messages, ...firstPage.messages].map((m) => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));

    const outsiderList = await fetch(
      `http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(outsider.token)}`
    );
    const outsiderBody = await outsiderList.json();
    assert.equal(
      outsiderBody.rooms.some((r) => r.roomId === roomId),
      false
    );

    const b = await connect(port, roomId, bTok.token);
    await waitMessage(b, (d) => d.type === "history");
    const dirB = await connectDirectory(port, bTok.token);
    await waitMessage(dirB, (d) => d.type === "rooms");
    b.send(JSON.stringify({ type: "read", seq: 999999 }));
    await new Promise((r) => setTimeout(r, 250));
    const nextId = `after-clamp-${now}`;
    const bGot = waitMessage(b, (d) => d.type === "message" && d.clientMessageId === nextId);
    const dirGot = waitMessage(
      dirB,
      (d) =>
        d.type === "rooms" &&
        d.rooms.some((r) => r.roomId === roomId && r.lastMessagePreview === "after-clamp")
    );
    a2.send(JSON.stringify({ type: "message", clientMessageId: nextId, body: "after-clamp" }));
    await bGot;
    const roomsAfter = await dirGot;
    const custom = roomsAfter.rooms.find((r) => r.roomId === roomId);
    assert.ok(custom);
    assert.ok(custom.unread >= 1, `unread after clamp should stay >=1, got ${custom.unread}`);
    assert.ok(custom.unread < 1000);

    const short = signTestTokenV2({
      userId: 1,
      displayName: "A",
      exp: Math.floor(Date.now() / 1000) + 2,
    });
    const expWs = await connect(port, roomId, short.token);
    await waitMessage(expWs, (d) => d.type === "history");
    await new Promise((r) => setTimeout(r, 2100));
    const expired = waitMessage(expWs, (d) => d.type === "error" && d.code === "expired_token");
    const closed = waitClose(expWs);
    expWs.send(JSON.stringify({ type: "message", clientMessageId: "late", body: "nope" }));
    const expEvent = await Promise.race([
      expired.then((d) => ({ kind: "msg", d })),
      closed.then((ev) => ({ kind: "close", ev })),
    ]);
    if (expEvent.kind === "msg") {
      assert.equal(expEvent.d.code, "expired_token");
    } else {
      assert.equal(expEvent.ev.code, 4008);
    }

    const v1 = signTestToken({ userId: 11, displayName: "Legacy", room: "team-1", team: "1조" });
    const v1ok = await fetch(`http://${HOST}:${port}/ws?room=team-1&token=${encodeURIComponent(v1.token)}`);
    assert.equal(v1ok.status, 426);
    const v1ws = await connect(port, "team-1", v1.token);
    const v1hist = await waitMessage(v1ws, (d) => d.type === "history");
    assert.equal(v1hist.type, "history");

    const v2legacy = await fetch(
      `http://${HOST}:${port}/ws?room=team-1&token=${encodeURIComponent(aTok.token)}`
    );
    assert.equal(v2legacy.status, 403);

    a2.close();
    b.close();
    dirB.close();
    v1ws.close();
  } finally {
    await stopWrangler(child);
  }
});
