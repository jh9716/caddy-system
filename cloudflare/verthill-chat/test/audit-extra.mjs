import assert from "node:assert/strict";
import test from "node:test";
import { signTestToken } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

function waitMessage(ws, predicate, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
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

function connect(port, room, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
    );
    const timer = setTimeout(() => reject(new Error("open timeout")), 8000);
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

test("history persist + pagination, 200-cap, DO restart with auth", async () => {
  const tok = signTestToken({ userId: 5, displayName: "P", room: "team-3", team: "3조" });
  const { port, child } = await startWrangler();
  let restartId = "";
  try {
    const a = await connect(port, "team-3", tok.token);
    await waitMessage(a, (d) => d.type === "history");
    const prefix = `hist-${Date.now()}`;
    for (let i = 0; i < 35; i += 1) {
      const id = `${prefix}-${i}`;
      const waiter = waitMessage(a, (d) => d.type === "message" && d.clientMessageId === id);
      a.send(JSON.stringify({ type: "message", clientMessageId: id, body: `h-${i}` }));
      await waiter;
    }
    a.close();
    const hist = await connect(port, "team-3", tok.token);
    const history = await waitMessage(hist, (d) => d.type === "history");
    const ids = history.messages.map((m) => m.clientMessageId);
    assert.equal(history.messages.length, 30);
    assert.equal(history.hasMore, true);
    assert.equal(ids.includes(`${prefix}-0`), false);
    assert.equal(ids.includes(`${prefix}-34`), true);
    const olderWait = waitMessage(
      hist,
      (d) => d.type === "history" && d.oldestSeq !== history.oldestSeq
    );
    hist.send(JSON.stringify({ type: "history", beforeSeq: history.oldestSeq, limit: 30 }));
    const older = await olderWait;
    const olderIds = older.messages.map((m) => m.clientMessageId);
    assert.equal(olderIds.includes(`${prefix}-0`), true);
    assert.equal(older.messages.some((m) => ids.includes(m.clientMessageId)), false);
    hist.close();

    const sockets = [];
    for (let i = 0; i < 200; i += 1) {
      const ws = await connect(port, "team-3", tok.token);
      await waitMessage(ws, (d) => d.type === "history");
      sockets.push(ws);
    }
    let full = false;
    try {
      await connect(port, "team-3", tok.token);
    } catch {
      full = true;
    }
    assert.equal(full, true);
    for (const ws of sockets) ws.close();
    await new Promise((r) => setTimeout(r, 200));

    restartId = `restart-${Date.now()}`;
    const persist = await connect(port, "team-3", tok.token);
    await waitMessage(persist, (d) => d.type === "history");
    const wait = waitMessage(persist, (d) => d.clientMessageId === restartId);
    persist.send(JSON.stringify({ type: "message", clientMessageId: restartId, body: "keep" }));
    await wait;
    persist.close();
  } finally {
    await stopWrangler(child);
  }

  const restarted = await startWrangler();
  try {
    const ws = await connect(restarted.port, "team-3", tok.token);
    const history = await waitMessage(ws, (d) => d.type === "history");
    assert.equal(
      history.messages.some((m) => m.clientMessageId === restartId),
      true
    );
    ws.close();
  } finally {
    await stopWrangler(restarted.child);
  }
});
