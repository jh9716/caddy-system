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

test("phase2 overall room, ACL, directory unread, admin spoof", async () => {
  const { port, child } = await startWrangler();
  try {
    const v1 = signTestToken({ userId: 1, displayName: "A", room: "team-1", team: "1조" });
    const v1All = await fetch(`http://${HOST}:${port}/ws?room=all&token=${encodeURIComponent(v1.token)}`);
    assert.equal(v1All.status, 403);

    const v2Team = signTestTokenV2({ userId: 1, displayName: "A" });
    const v2Legacy = await fetch(
      `http://${HOST}:${port}/ws?room=team-1&token=${encodeURIComponent(v2Team.token)}`
    );
    assert.equal(v2Legacy.status, 403);

    const aTok = signTestTokenV2({ userId: 1, displayName: "A", role: "caddy" });
    const bTok = signTestTokenV2({ userId: 2, displayName: "B", role: "caddy" });
    const adminTok = signTestTokenV2({ userId: 9, displayName: "관리자김", role: "admin" });

    const a = await connect(port, "all", aTok.token);
    await waitMessage(a, (d) => d.type === "history");
    const b = await connect(port, "all", bTok.token);
    await waitMessage(b, (d) => d.type === "history");

    const idAb = `all-ab-${Date.now()}`;
    const bGot = waitMessage(b, (d) => d.type === "message" && d.clientMessageId === idAb);
    a.send(
      JSON.stringify({
        type: "message",
        clientMessageId: idAb,
        senderRole: "admin",
        body: "hello-all",
      })
    );
    const fromA = await bGot;
    assert.equal(fromA.sender, "A");
    assert.equal(fromA.senderUserId, 1);
    assert.equal(fromA.senderRole, "caddy");
    assert.equal(fromA.body, "hello-all");

    const admin = await connect(port, "all", adminTok.token);
    await waitMessage(admin, (d) => d.type === "history");
    const idAd = `all-admin-${Date.now()}`;
    const aGotAdmin = waitMessage(a, (d) => d.type === "message" && d.clientMessageId === idAd);
    admin.send(JSON.stringify({ type: "message", clientMessageId: idAd, body: "운영 변경" }));
    const adminMsg = await aGotAdmin;
    assert.equal(adminMsg.senderRole, "admin");
    assert.equal(adminMsg.sender, "관리자김");

    const now = Math.floor(Date.now() / 1000);
    const roomId = "room_0123456789abcdef";
    const grant = signCreateGrant({
      v: 1,
      op: "create_room",
      roomId,
      name: "대바",
      ownerUserId: 1,
      members: [
        { userId: 1, displayName: "A", role: "caddy", team: "1조" },
        { userId: 2, displayName: "B", role: "caddy", team: "2조" },
      ],
      iat: now,
      exp: now + 60,
    });
    const created = await fetch(`http://${HOST}:${port}/directory/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant }),
    });
    assert.equal(created.status, 200);

    const outsider = signTestTokenV2({ userId: 3, displayName: "C" });
    const denied = await fetch(
      `http://${HOST}:${port}/ws?room=${roomId}&token=${encodeURIComponent(outsider.token)}`
    );
    assert.equal(denied.status, 403);

    const customA = await connect(port, roomId, aTok.token);
    await waitMessage(customA, (d) => d.type === "history");
    const customB = await connect(port, roomId, bTok.token);
    await waitMessage(customB, (d) => d.type === "history");
    const idCustom = `custom-${Date.now()}`;
    const customGot = waitMessage(customB, (d) => d.type === "message" && d.clientMessageId === idCustom);
    customA.send(JSON.stringify({ type: "message", clientMessageId: idCustom, body: "대바 안녕" }));
    const customMsg = await customGot;
    assert.equal(customMsg.body, "대바 안녕");

    const dir = await connectDirectory(port, bTok.token);
    const roomsEvent = await waitMessage(dir, (d) => d.type === "rooms" && Array.isArray(d.rooms));
    assert.equal(roomsEvent.rooms[0].roomId, "all");
    const custom = roomsEvent.rooms.find((r) => r.roomId === roomId);
    assert.ok(custom);
    assert.equal(custom.name, "대바");
    assert.ok(custom.unread >= 1);
    assert.equal(custom.notificationTag, `chat:${roomId}`);

    const list = await fetch(
      `http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(outsider.token)}`
    );
    const listBody = await list.json();
    assert.equal(list.status, 200);
    assert.equal(listBody.rooms[0].roomId, "all");
    assert.equal(
      listBody.rooms.some((r) => r.roomId === roomId),
      false
    );

    const outsiderMembers = await fetch(
      `http://${HOST}:${port}/directory/rooms/${roomId}/members?token=${encodeURIComponent(outsider.token)}`
    );
    assert.equal(outsiderMembers.status, 403);
    const outsiderMembersBody = await outsiderMembers.json();
    assert.equal(outsiderMembersBody.error, "room_forbidden");
    assert.equal(outsiderMembersBody.members, undefined);

    const memberList = await fetch(
      `http://${HOST}:${port}/directory/rooms/${roomId}/members?token=${encodeURIComponent(aTok.token)}`
    );
    const memberListBody = await memberList.json();
    assert.equal(memberList.status, 200);
    assert.equal(memberListBody.members.length, 2);
    assert.deepEqual(
      memberListBody.members.map((m) => m.userId).sort(),
      [1, 2]
    );
    assert.equal(
      memberListBody.members.every((m) => !("phone" in m) && !("kakaoUserId" in m)),
      true
    );

    const allMembers = await fetch(
      `http://${HOST}:${port}/directory/rooms/all/members?token=${encodeURIComponent(outsider.token)}`
    );
    const allMembersBody = await allMembers.json();
    assert.equal(allMembers.status, 200);
    assert.deepEqual(allMembersBody.members, []);

    const oldClient = `old-client-${Date.now()}`;
    const oldClientGot = waitMessage(b, (d) => d.type === "message" && d.clientMessageId === oldClient);
    a.send(JSON.stringify({ type: "message", clientMessageId: oldClient, body: "phase2-payload" }));
    const oldClientMsg = await oldClientGot;
    assert.deepEqual(oldClientMsg.mentions, []);
    assert.equal(oldClientMsg.mentionAll, false);

    const idMention = `all-mention-${Date.now()}`;
    const mentionGot = waitMessage(b, (d) => d.type === "message" && d.clientMessageId === idMention);
    a.send(
      JSON.stringify({
        type: "message",
        clientMessageId: idMention,
        body: "@B 확인",
        mentions: [2, 2, 0, "x"],
        mentionAll: true,
      })
    );
    const mentionMsg = await mentionGot;
    assert.deepEqual(mentionMsg.mentions, [{ userId: 2 }]);
    assert.equal(mentionMsg.mentionAll, false);

    const idAll = `admin-all-${Date.now()}`;
    const allGot = waitMessage(a, (d) => d.type === "message" && d.clientMessageId === idAll);
    admin.send(
      JSON.stringify({
        type: "message",
        clientMessageId: idAll,
        body: "@전체 확인",
        mentionAll: true,
        mentions: [1],
      })
    );
    const allMsg = await allGot;
    assert.equal(allMsg.mentionAll, true);
    assert.deepEqual(allMsg.mentions, [{ userId: 1 }]);

    const leaderTok = signTestTokenV2({ userId: 8, displayName: "리더", role: "leader" });
    const leader = await connect(port, "all", leaderTok.token);
    await waitMessage(leader, (d) => d.type === "history");
    const idLeader = `leader-all-${Date.now()}`;
    const leaderGot = waitMessage(a, (d) => d.type === "message" && d.clientMessageId === idLeader);
    leader.send(
      JSON.stringify({
        type: "message",
        clientMessageId: idLeader,
        body: "@전체 조장",
        mentionAll: true,
      })
    );
    const leaderMsg = await leaderGot;
    assert.equal(leaderMsg.mentionAll, true);

    const idOut = `custom-out-${Date.now()}`;
    const customMentionGot = waitMessage(customB, (d) => d.type === "message" && d.clientMessageId === idOut);
    customA.send(
      JSON.stringify({
        type: "message",
        clientMessageId: idOut,
        body: "@C 불가",
        mentions: [3, 2],
      })
    );
    const customMention = await customMentionGot;
    assert.deepEqual(customMention.mentions, [{ userId: 2 }]);

    const histWs = await connect(port, "all", aTok.token);
    const hist = await waitMessage(histWs, (d) => d.type === "history");
    const oldish = hist.messages.find((m) => m.clientMessageId === idAb);
    assert.ok(oldish);
    assert.deepEqual(oldish.mentions, []);
    assert.equal(oldish.mentionAll, false);
    const storedAll = hist.messages.find((m) => m.clientMessageId === idAll);
    assert.equal(storedAll.mentionAll, true);

    a.close();
    b.close();
    admin.close();
    leader.close();
    customA.close();
    customB.close();
    histWs.close();
    dir.close();
  } finally {
    await stopWrangler(child);
  }
});
