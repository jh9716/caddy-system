/**
 * Directory list hotfix: WS snapshot + ChatRoom → Directory preview.
 * Local wrangler only. No Production writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

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
    let opened = false;
    const timer = setTimeout(() => reject(new Error("directory ws timeout")), 8000);
    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      if (opened) return;
      clearTimeout(timer);
      reject(new Error("directory ws error"));
    });
    ws.addEventListener("close", (ev) => {
      if (opened) return;
      clearTimeout(timer);
      reject(new Error(`directory ws closed code=${ev.code} reason=${ev.reason}`));
    });
  });
}

test("directory WS snapshot + all-room preview after message + reconnect", async () => {
  const { port, child } = await startWrangler();
  try {
    const noUpgrade = await fetch(`http://${HOST}:${port}/directory/ws`);
    assert.equal(noUpgrade.status, 401);

    const aTok = signTestTokenV2({ userId: 11, displayName: "목록A", role: "caddy" });
    const bTok = signTestTokenV2({ userId: 12, displayName: "목록B", role: "caddy" });

    const dir = await connectDirectory(port, aTok.token);
    const first = await waitMessage(dir, (d) => d.type === "rooms" && Array.isArray(d.rooms));
    const all = first.rooms.find((r) => r.roomId === "all");
    assert.ok(all, "initial snapshot includes all room");
    assert.equal(all.name, "전체 채팅방");
    assert.equal(all.type, "ALL");

    const httpBefore = await fetch(
      `http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(aTok.token)}`
    );
    const httpBeforeBody = await httpBefore.json();
    assert.equal(httpBefore.status, 200);
    assert.equal(httpBeforeBody.rooms[0].roomId, "all");

    const room = await connect(port, "all", aTok.token);
    await waitMessage(room, (d) => d.type === "history");
    const id = `dir-preview-${Date.now()}`;
    const previewWait = waitMessage(
      dir,
      (d) =>
        d.type === "rooms" &&
        Array.isArray(d.rooms) &&
        d.rooms.some((r) => r.roomId === "all" && r.lastMessagePreview === "목록hotfix")
    );
    room.send(
      JSON.stringify({
        type: "message",
        clientMessageId: id,
        body: "목록hotfix",
      })
    );
    const updated = await previewWait;
    const after = updated.rooms.find((r) => r.roomId === "all");
    assert.equal(after.lastMessagePreview, "목록hotfix");
    assert.equal(after.lastSenderName, "목록A");
    assert.ok(after.lastMessageAt);
    assert.ok(after.lastMessageSeq >= 1);

    room.close();
    const roomAgain = await connect(port, "all", aTok.token);
    const hist = await waitMessage(roomAgain, (d) => d.type === "history");
    assert.ok(hist.messages.some((m) => m.body === "목록hotfix"), "ChatRoom SQLite kept the message");
    roomAgain.close();

    dir.close();
    const dir2 = await connectDirectory(port, bTok.token);
    const snap2 = await waitMessage(dir2, (d) => d.type === "rooms" && Array.isArray(d.rooms));
    const all2 = snap2.rooms.find((r) => r.roomId === "all");
    assert.equal(all2.lastMessagePreview, "목록hotfix", "reconnect snapshot keeps preview");
    assert.equal(all2.lastSenderName, "목록A");

    const httpAfter = await fetch(
      `http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(bTok.token)}`
    );
    const httpAfterBody = await httpAfter.json();
    const httpAll = httpAfterBody.rooms.find((r) => r.roomId === "all");
    assert.equal(httpAll.lastMessagePreview, "목록hotfix");
    dir2.close();
  } finally {
    await stopWrangler(child);
  }
});
