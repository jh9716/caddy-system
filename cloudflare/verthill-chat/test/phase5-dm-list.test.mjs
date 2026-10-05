import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TEST_SECRET, signCreateGrant, signTestTokenV2 } from "./token-helper.mjs";

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
  const persistTo = mkdtempSync(join(tmpdir(), "vh-dm-list-"));
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
      "--persist-to",
      persistTo,
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

async function listRooms(port, token) {
  const res = await fetch(`http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(token)}`);
  const body = await res.json();
  return { status: res.status, rooms: Array.isArray(body.rooms) ? body.rooms : [] };
}

test("phase5 dm create appears in creator/peer lists and directory snapshot", async () => {
  const { port, child } = await startWrangler();
  try {
    const aTok = signTestTokenV2({ userId: 8, displayName: "신정훈", team: "7조" });
    const bTok = signTestTokenV2({ userId: 40, displayName: "이기흥", role: "admin", team: "-" });
    const outsider = signTestTokenV2({ userId: 99, displayName: "외부" });
    const roomId = "dm_8_40";
    const now = Math.floor(Date.now() / 1000);
    const grantBody = {
      v: 1,
      op: "create_room",
      roomId,
      name: "DM",
      ownerUserId: 8,
      members: [
        { userId: 8, displayName: "신정훈", role: "caddy", team: "7조" },
        { userId: 40, displayName: "이기흥", role: "admin", team: "-" },
      ],
      iat: now,
      exp: now + 60,
    };

    const dirA = await connectDirectory(port, aTok.token);
    await waitMessage(dirA, (d) => d.type === "rooms" && Array.isArray(d.rooms));
    const afterCreate = waitMessage(
      dirA,
      (d) => d.type === "rooms" && Array.isArray(d.rooms) && d.rooms.some((r) => r.roomId === roomId)
    );

    const created = await fetch(`http://${HOST}:${port}/directory/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: signCreateGrant(grantBody) }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 200);
    assert.equal(createdBody.roomId, roomId);
    assert.notEqual(createdBody.idempotent, true);

    const snapshot = await afterCreate;
    assert.equal(snapshot.rooms[0].roomId, "all");
    const dmFromEvent = snapshot.rooms.find((r) => r.roomId === roomId);
    assert.ok(dmFromEvent);
    assert.equal(dmFromEvent.type, "DM");
    assert.equal(dmFromEvent.peerUserId, 40);
    assert.equal(dmFromEvent.peerDisplayName, "이기흥");

    const creatorList = await listRooms(port, aTok.token);
    assert.equal(creatorList.status, 200);
    assert.equal(creatorList.rooms[0].roomId, "all");
    assert.equal(creatorList.rooms.filter((r) => r.roomId === roomId).length, 1);

    const peerList = await listRooms(port, bTok.token);
    assert.equal(peerList.rooms.some((r) => r.roomId === roomId && r.type === "DM"), true);
    assert.equal(peerList.rooms.find((r) => r.roomId === roomId).peerUserId, 8);

    const outsiderList = await listRooms(port, outsider.token);
    assert.equal(outsiderList.rooms.some((r) => r.roomId === roomId), false);
    assert.equal(outsiderList.rooms[0].roomId, "all");

    const again = await fetch(`http://${HOST}:${port}/directory/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: signCreateGrant({ ...grantBody, iat: now + 1, exp: now + 61 }) }),
    });
    const againBody = await again.json();
    assert.equal(again.status, 200);
    assert.equal(againBody.idempotent, true);
    const creatorAgain = await listRooms(port, aTok.token);
    assert.equal(creatorAgain.rooms.filter((r) => r.roomId === roomId).length, 1);

    const denied = await fetch(
      `http://${HOST}:${port}/ws?room=${roomId}&token=${encodeURIComponent(outsider.token)}`
    );
    assert.equal(denied.status, 403);

    const a = await connect(port, roomId, aTok.token);
    await waitMessage(a, (d) => d.type === "history");
    const b = await connect(port, roomId, bTok.token);
    await waitMessage(b, (d) => d.type === "history");
    const mid = `dm-${Date.now()}`;
    const got = waitMessage(b, (d) => d.type === "message" && d.clientMessageId === mid);
    a.send(JSON.stringify({ type: "message", clientMessageId: mid, body: "1:1 안녕", mentionAll: true }));
    const msg = await got;
    assert.equal(msg.body, "1:1 안녕");
    assert.equal(msg.mentionAll, false);

    a.close();
    const a2 = await connect(port, roomId, aTok.token);
    const hist = await waitMessage(a2, (d) => d.type === "history");
    assert.equal(hist.messages.some((m) => m.clientMessageId === mid), true);

    const allRoom = await connect(port, "all", aTok.token);
    await waitMessage(allRoom, (d) => d.type === "history");

    dirA.close();
    b.close();
    a2.close();
    allRoom.close();
  } finally {
    await stopWrangler(child);
  }
});
