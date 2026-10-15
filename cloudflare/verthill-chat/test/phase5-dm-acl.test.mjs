/**
 * Canonical DM contract + stale membership repair against local wrangler.
 * Production Worker/DB are never touched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { signCreateGrant, signTestTokenV2 } from "./token-helper.mjs";
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

async function wsStatus(port, room, token) {
  const res = await fetch(
    `http://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function listRooms(port, token) {
  const res = await fetch(`http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(token)}`);
  const body = await res.json();
  return { status: res.status, rooms: Array.isArray(body.rooms) ? body.rooms : [] };
}

async function listMembers(port, roomId, token) {
  const res = await fetch(
    `http://${HOST}:${port}/directory/rooms/${encodeURIComponent(roomId)}/members?token=${encodeURIComponent(token)}`
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, members: Array.isArray(body.members) ? body.members : [] };
}

function grantFor(roomId, ownerUserId, members, skew = 0) {
  const now = Math.floor(Date.now() / 1000) + skew;
  return signCreateGrant({
    v: 1,
    op: "create_room",
    roomId,
    name: "DM",
    ownerUserId,
    members,
    iat: now,
    exp: now + 60,
  });
}

async function createDm(port, roomId, ownerUserId, members, skew = 0) {
  const res = await fetch(`http://${HOST}:${port}/directory/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant: grantFor(roomId, ownerUserId, members, skew) }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

function addDmMember(persistTo, roomId, userId) {
  const file = findDirectorySqlite(persistTo);
  assert.ok(file, "Directory sqlite exists before extra seed");
  const db = new DatabaseSync(file);
  db.prepare(
    `INSERT OR IGNORE INTO members (room_id, user_id, display_name, role, team, joined_at)
     VALUES (?, ?, ?, 'caddy', '-', ?)`
  ).run(roomId, userId, `extra-${userId}`, new Date().toISOString());
  db.prepare(
    `UPDATE rooms SET member_count = (SELECT COUNT(*) FROM members WHERE room_id = ?) WHERE room_id = ?`
  ).run(roomId, roomId);
  const members = db
    .prepare("SELECT user_id FROM members WHERE room_id = ?")
    .all(roomId)
    .map((row) => Number(row.user_id))
    .sort((a, b) => a - b);
  const count = Number(
    db.prepare("SELECT member_count FROM rooms WHERE room_id = ?").get(roomId)?.member_count || 0
  );
  db.close();
  return { members, count };
}

function waitClose(ws, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      resolve({ code: 4003, reason: "already-closing" });
      return;
    }
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    const finish = (ev) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve(ev);
    };
    ws.addEventListener("close", (ev) => finish(ev));
    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data?.type === "error" && data.code === "room_forbidden") {
          finish({ code: 4003, reason: "room_forbidden" });
        }
      } catch {
        // ignore
      }
    });
    const poll = setInterval(() => {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        finish({ code: 4003, reason: "readyState-closing" });
      }
    }, 50);
  });
}

test("phase5 dm acl: both sides, idempotent, repair, third-party, tokens", async () => {
  const persistTo = mkdtempSync(join(tmpdir(), "vh-dm-acl-"));
  const a = { userId: 8, displayName: "신정훈", role: "caddy", team: "7조" };
  const b = { userId: 40, displayName: "이기흥", role: "admin", team: "-" };
  const c = { userId: 99, displayName: "외부", role: "caddy", team: "1조" };
  const staleA = { userId: 10, displayName: "A10", role: "caddy", team: "3조" };
  const staleB = { userId: 20, displayName: "B20", role: "caddy", team: "4조" };
  const roomId = "dm_8_40";
  const staleRoom = "dm_10_20";
  const extraRoom = "dm_11_21";
  const extraA = { userId: 11, displayName: "A11", role: "caddy", team: "3조" };
  const extraB = { userId: 21, displayName: "B21", role: "caddy", team: "4조" };
  const customId = "room_bbbbbbbbbbbbbbbb";

  const { port, child, mock } = await startWrangler({ persistTo });
  try {
    const aTok = signTestTokenV2(a);
    const bTok = signTestTokenV2(b);
    const cTok = signTestTokenV2(c);
    const staleATok = signTestTokenV2(staleA);
    const staleBTok = signTestTokenV2(staleB);

    const seed = await createDm(port, staleRoom, staleA.userId, [staleA, staleB]);
    assert.equal(seed.status, 200, "seed stale room create");
    assert.notEqual(seed.body.idempotent, true);
    const seedMembers = await listMembers(port, staleRoom, staleATok.token);
    assert.deepEqual(
      seedMembers.members.map((m) => m.userId).sort((x, y) => x - y),
      [10, 20]
    );
    const staleBOpen = await wsStatus(port, staleRoom, staleBTok.token);
    assert.equal(staleBOpen.status, 426, "complete seed allows B HTTP upgrade_required");
    const seedOpen = await connect(port, staleRoom, staleATok.token);
    await waitMessage(seedOpen, (d) => d.type === "history");
    seedOpen.close();
    const remaining = dropDmMember(persistTo, staleRoom, 20);
    assert.deepEqual(remaining, [10], "live sqlite surgery leaves only creator member");

    const missingB = await wsStatus(port, staleRoom, staleBTok.token);
    assert.equal(missingB.status, 403, "stale missing member cannot open");
    assert.equal(missingB.body.error, "room_forbidden");

    const repaired = await createDm(port, staleRoom, staleB.userId, [staleB, staleA], 1);
    assert.equal(repaired.status, 200, "peer startDm repairs missing member");
    assert.equal(repaired.body.repaired, true);
    assert.notEqual(repaired.body.idempotent, true);

    const repairedMembers = await listMembers(port, staleRoom, staleBTok.token);
    assert.deepEqual(
      repairedMembers.members.map((m) => m.userId).sort((x, y) => x - y),
      [10, 20],
      "repair restores both canonical members"
    );
    assert.equal((await wsStatus(port, staleRoom, staleATok.token)).status, 426);
    assert.equal((await wsStatus(port, staleRoom, staleBTok.token)).status, 426);

    const wrongPair = await createDm(
      port,
      staleRoom,
      staleA.userId,
      [staleA, { ...c, userId: 99 }],
      2
    );
    assert.equal(wrongPair.status, 400, "wrong canonical pair cannot repair");
    assert.equal(wrongPair.body.error, "dm_pair_mismatch");
    const afterWrong = await listMembers(port, staleRoom, staleATok.token);
    assert.deepEqual(
      afterWrong.members.map((m) => m.userId).sort((x, y) => x - y),
      [10, 20],
      "wrong pair leaves membership untouched"
    );

    const extraATok = signTestTokenV2(extraA);
    const extraBTok = signTestTokenV2(extraB);
    const extraSeed = await createDm(port, extraRoom, extraA.userId, [extraA, extraB], 7);
    assert.equal(extraSeed.status, 200, "seed extra-member room create");
    const extrasSeeded = addDmMember(persistTo, extraRoom, 99);
    assert.deepEqual(extrasSeeded.members, [11, 21, 99], "live sqlite seed adds third party C");
    assert.equal(extrasSeeded.count, 3, "stale extra member_count is 3");
    const extraBefore = await listMembers(port, extraRoom, extraATok.token);
    assert.deepEqual(
      extraBefore.members.map((m) => m.userId).sort((x, y) => x - y),
      [11, 21, 99],
      "stale extras [A,B,C] visible before repair"
    );
    assert.equal((await listRooms(port, cTok.token)).rooms.some((r) => r.roomId === extraRoom), true);
    assert.equal((await wsStatus(port, extraRoom, cTok.token)).status, 426, "C can still open before repair");
    const cOpen = await connect(port, extraRoom, cTok.token);
    await waitMessage(cOpen, (d) => d.type === "history");
    const cClosed = waitClose(cOpen, 12000);

    const wrongExtra = await createDm(
      port,
      extraRoom,
      extraA.userId,
      [extraA, { ...c, userId: 99 }],
      8
    );
    assert.equal(wrongExtra.status, 400, "wrong pair cannot add/delete C");
    assert.equal(wrongExtra.body.error, "dm_pair_mismatch");
    const stillExtras = await listMembers(port, extraRoom, extraATok.token);
    assert.deepEqual(
      stillExtras.members.map((m) => m.userId).sort((x, y) => x - y),
      [11, 21, 99],
      "wrong pair leaves extra member C"
    );

    const extraRepaired = await createDm(port, extraRoom, extraA.userId, [extraA, extraB], 9);
    assert.equal(extraRepaired.status, 200, "A/B grant removes extra C");
    assert.equal(extraRepaired.body.repaired, true);
    assert.deepEqual(
      (Array.isArray(extraRepaired.body.removed) ? extraRepaired.body.removed : [])
        .map((id) => Number(id))
        .sort((x, y) => x - y),
      [99],
      `repair reports removed C: ${JSON.stringify(extraRepaired.body)}`
    );
    assert.equal(extraRepaired.body.evictStatus, 200, `Worker ChatRoom evict poke ok: ${JSON.stringify(extraRepaired.body)}`);
    assert.ok(Number(extraRepaired.body.evicted) >= 1, `Worker evict closed C socket: ${JSON.stringify(extraRepaired.body)}`);
    const closed = await cClosed;
    assert.ok(closed, `open C socket closed after evict: ${JSON.stringify(extraRepaired.body)}`);
    assert.notEqual(cOpen.readyState, WebSocket.OPEN, "C residual socket is not left open");
    const extraAfter = await listMembers(port, extraRoom, extraATok.token);
    assert.deepEqual(
      extraAfter.members.map((m) => m.userId).sort((x, y) => x - y),
      [11, 21],
      "members exactly [A, B]"
    );
    const extraSummary = (await listRooms(port, extraATok.token)).rooms.find((r) => r.roomId === extraRoom);
    assert.equal(extraSummary?.memberCount, 2, "member_count is 2 after exact-pair repair");
    assert.equal((await listRooms(port, cTok.token)).rooms.some((r) => r.roomId === extraRoom), false, "C list drops DM");
    const cDenied = await wsStatus(port, extraRoom, cTok.token);
    assert.equal(cDenied.status, 403, "C new WS forbidden");
    assert.equal(cDenied.body.error, "room_forbidden");
    assert.equal((await wsStatus(port, extraRoom, extraATok.token)).status, 426, "A still opens extra room");
    assert.equal((await wsStatus(port, extraRoom, extraBTok.token)).status, 426, "B still opens extra room");

    const created = await createDm(port, roomId, a.userId, [a, b], 3);
    assert.equal(created.status, 200);
    assert.equal(created.body.roomId, roomId);
    assert.notEqual(created.body.idempotent, true);
    assert.notEqual(created.body.repaired, true);

    const aList = await listRooms(port, aTok.token);
    const bList = await listRooms(port, bTok.token);
    const cList = await listRooms(port, cTok.token);
    assert.equal(aList.rooms.some((r) => r.roomId === roomId), true, "A sees DM");
    assert.equal(bList.rooms.some((r) => r.roomId === roomId), true, "B sees same DM");
    assert.equal(cList.rooms.some((r) => r.roomId === roomId), false, "third user list hidden");

    const aWs = await connect(port, roomId, aTok.token);
    await waitMessage(aWs, (d) => d.type === "history");
    const bWs = await connect(port, roomId, bTok.token);
    await waitMessage(bWs, (d) => d.type === "history");

    const fromB = await createDm(port, roomId, b.userId, [b, a], 4);
    assert.equal(fromB.status, 200, "B startDm(A) reuses room");
    assert.equal(fromB.body.idempotent, true);
    assert.notEqual(fromB.body.repaired, true);

    const fromA = await createDm(port, roomId, a.userId, [a, b], 5);
    assert.equal(fromA.status, 200, "A startDm(B) again idempotent");
    assert.equal(fromA.body.idempotent, true);

    const members = await listMembers(port, roomId, aTok.token);
    assert.deepEqual(
      members.members.map((m) => m.userId).sort((x, y) => x - y),
      [8, 40],
      "both membership true"
    );

    const outsider = await wsStatus(port, roomId, cTok.token);
    assert.equal(outsider.status, 403, "third user forbidden");
    assert.equal(outsider.body.error, "room_forbidden");

    const self = await createDm(port, "dm_8_8", 8, [a, a], 6);
    assert.equal(self.status, 400);
    assert.ok(["invalid_room", "invalid_dm_members"].includes(self.body.error));

    const againHealthy = await wsStatus(port, roomId, aTok.token);
    assert.equal(againHealthy.status, 426, "existing normal DM still authorized");

    const custom = await fetch(`http://${HOST}:${port}/directory/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant: signCreateGrant({
          v: 1,
          op: "create_room",
          roomId: customId,
          name: "조모임",
          ownerUserId: 8,
          members: [a, b],
          iat: Math.floor(Date.now() / 1000) + 7,
          exp: Math.floor(Date.now() / 1000) + 67,
        }),
      }),
    });
    assert.equal(custom.status, 200, "custom room create still works");
    const customWs = await connect(port, customId, aTok.token);
    await waitMessage(customWs, (d) => d.type === "history");
    const allWs = await connect(port, "all", aTok.token);
    await waitMessage(allWs, (d) => d.type === "history");

    const sessionTok = signTestTokenV2({ ...a, sv: 3 });
    mock.setEpoch(8, 3);
    assert.equal((await wsStatus(port, roomId, sessionTok.token)).status, 426, "8-part session-bound ok");
    mock.setEpoch(8, 4);
    const stale = await wsStatus(port, roomId, sessionTok.token);
    assert.equal(stale.status, 401, "stale/revoked token blocked");
    assert.equal(stale.body.error, "stale_session");

    const mid = `dm-acl-${Date.now()}`;
    const got = waitMessage(bWs, (d) => d.type === "message" && d.clientMessageId === mid);
    aWs.send(JSON.stringify({ type: "message", clientMessageId: mid, body: "수리 후 안녕" }));
    const msg = await got;
    assert.equal(msg.body, "수리 후 안녕");

    aWs.close();
    bWs.close();
    customWs.close();
    allWs.close();
  } finally {
    await stopWrangler(child);
  }
});
